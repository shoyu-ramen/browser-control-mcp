export class WorkflowEngine {
  constructor(sendCommand, sessionState) {
    this.workflows = new Map();
    this.sendCommand = sendCommand;
    this.sessionState = sessionState;
    this.messageBus = null;
    this.nextId = 1;
  }

  setMessageBus(bus) {
    this.messageBus = bus;
  }

  async execute(steps, options = {}) {
    const id = `wf_${this.nextId++}`;
    const workflow = {
      id, steps, options,
      status: "running",
      currentStep: 0,
      results: [],
      startedAt: Date.now(),
      completedAt: null,
      error: null,
    };
    this.workflows.set(id, workflow);
    this._emitStatus(id, "started", { totalSteps: steps.length, name: options.name });
    this._run(workflow).catch(() => {});
    return { id, status: "running", totalSteps: steps.length };
  }

  async _run(workflow) {
    try {
      for (let i = 0; i < workflow.steps.length; i++) {
        if (workflow.status === "cancelled") break;
        workflow.currentStep = i;
        const step = workflow.steps[i];

        if (step.condition) {
          const met = await this._checkCondition(step.condition);
          if (!met) {
            workflow.results.push({ step: i, skipped: true, reason: "condition_not_met" });
            continue;
          }
        }

        if (step.delayMs) await new Promise(r => setTimeout(r, step.delayMs));

        let lastErr = null;
        const retries = step.maxRetries || 0;

        for (let attempt = 0; attempt <= retries; attempt++) {
          try {
            const result = await this.sendCommand(step.command, step.params || {}, step.timeoutMs || 15000);
            workflow.results.push({ step: i, attempt, success: true, result });
            lastErr = null;
            break;
          } catch (err) {
            lastErr = err;
            if (attempt < retries) await new Promise(r => setTimeout(r, step.retryDelayMs || 1000));
          }
        }

        if (lastErr) {
          if (step.onError === "skip") {
            workflow.results.push({ step: i, skipped: true, reason: "error", error: lastErr.message });
            continue;
          }
          throw lastErr;
        }
      }
      if (workflow.status === "running") {
        workflow.status = "completed";
        this._emitStatus(workflow.id, "completed", { results: workflow.results.length });
      }
    } catch (err) {
      workflow.status = "failed";
      workflow.error = `Step ${workflow.currentStep} (${workflow.steps[workflow.currentStep]?.command}) failed: ${err.message}`;
      this._emitStatus(workflow.id, "failed", { error: workflow.error, step: workflow.currentStep });
    }
    workflow.completedAt = Date.now();
  }

  _emitStatus(workflowId, event, data) {
    if (this.messageBus) {
      this.messageBus.broadcast("system", `workflow.${event}`, { workflowId, ...data });
    }
  }

  async _checkCondition(cond) {
    try {
      if (cond.type === "element_exists") {
        const r = await this.sendCommand("find_elements", { selector: cond.selector, limit: 1 });
        return r?.success && r.data?.count > 0;
      }
      if (cond.type === "url_matches") {
        const r = await this.sendCommand("get_active_tab_info");
        return r?.success && r.data?.url?.includes(cond.pattern);
      }
      if (cond.type === "variable_equals") {
        return this.sessionState?.getVariable(cond.name) === cond.value;
      }
    } catch {}
    return true;
  }

  getStatus(id) {
    const w = this.workflows.get(id);
    if (!w) return null;
    return {
      id: w.id, status: w.status, currentStep: w.currentStep,
      totalSteps: w.steps.length, results: w.results,
      startedAt: w.startedAt, completedAt: w.completedAt, error: w.error,
    };
  }

  cancel(id) {
    const w = this.workflows.get(id);
    if (!w || w.status !== "running") return false;
    w.status = "cancelled";
    w.completedAt = Date.now();
    return true;
  }

  list() {
    return [...this.workflows.values()].map(w => ({
      id: w.id, status: w.status, currentStep: w.currentStep,
      totalSteps: w.steps.length, startedAt: w.startedAt,
      completedAt: w.completedAt, error: w.error,
    }));
  }
}
