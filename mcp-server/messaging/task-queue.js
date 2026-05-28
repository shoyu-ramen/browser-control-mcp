import { randomBytes } from "crypto";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { Persistence } from "./persistence.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(__dirname, "..", "data", "tasks.json");

const MAX_TASKS = 1000;

export class TaskQueue {
  constructor(messageBus, registry) {
    this._tasks = new Map();
    this._messageBus = messageBus;
    this._registry = registry;
    this._persistence = new Persistence();
    this._load();
  }

  _load() {
    const data = this._persistence.loadJSON(DATA_FILE);
    if (Array.isArray(data)) {
      for (const task of data) {
        this._tasks.set(task.id, task);
      }
    }
  }

  _persist() {
    this._persistence.saveJSONDebounced(DATA_FILE, [...this._tasks.values()]);
  }

  _emit(topic, payload) {
    if (this._messageBus) {
      this._messageBus.broadcast("system", topic, payload);
    }
  }

  submit({ type, description, params, requiredCapability, assignTo, priority, createdBy }) {
    if (this._tasks.size >= MAX_TASKS) {
      return { success: false, error: "max_tasks_exceeded", limit: MAX_TASKS };
    }

    const perms = this._registry?.getPermissions(createdBy);
    if (perms && !perms.canDelegate) {
      return { success: false, error: "role_not_authorized", message: "This agent role cannot delegate tasks" };
    }

    const id = `task_${randomBytes(6).toString("hex")}`;
    const task = {
      id,
      type: type || "generic",
      description: description || "",
      params: params || {},
      status: "pending",
      priority: priority || "normal",
      requiredCapability: requiredCapability || null,
      assignedTo: assignTo || null,
      createdBy,
      claimedBy: null,
      result: null,
      error: null,
      createdAt: Date.now(),
      claimedAt: null,
      completedAt: null,
    };

    this._tasks.set(id, task);
    this._persist();

    if (assignTo) {
      task.status = "assigned";
      this._messageBus?.send("system", assignTo, {
        type: "task.assigned",
        taskId: id,
        task: { type: task.type, description: task.description, params: task.params, priority: task.priority },
      });
    }

    this._emit("task.created", { taskId: id, type: task.type, priority: task.priority, requiredCapability });
    return { success: true, taskId: id };
  }

  claim(taskId, agentId) {
    const task = this._tasks.get(taskId);
    if (!task) return { success: false, error: "task_not_found" };
    if (task.status !== "pending" && task.status !== "assigned") {
      return { success: false, error: "task_not_claimable", status: task.status };
    }
    if (task.assignedTo && task.assignedTo !== agentId) {
      return { success: false, error: "task_assigned_to_other" };
    }

    const perms = this._registry?.getPermissions(agentId);
    if (perms && !perms.canClaim) {
      return { success: false, error: "role_not_authorized", message: "This agent role cannot claim tasks" };
    }

    if (task.requiredCapability) {
      const agent = this._registry?.get(agentId);
      if (agent && !agent.capabilities.includes(task.requiredCapability)) {
        return { success: false, error: "missing_capability", required: task.requiredCapability };
      }
    }

    task.status = "running";
    task.claimedBy = agentId;
    task.claimedAt = Date.now();
    this._persist();
    this._emit("task.claimed", { taskId, claimedBy: agentId });
    return { success: true };
  }

  complete(taskId, agentId, result) {
    const task = this._tasks.get(taskId);
    if (!task) return { success: false, error: "task_not_found" };
    if (task.claimedBy !== agentId) return { success: false, error: "not_task_owner" };
    if (task.status !== "running") return { success: false, error: "task_not_running" };

    task.status = "completed";
    task.result = result;
    task.completedAt = Date.now();
    this._persist();

    this._emit("task.completed", { taskId, completedBy: agentId, result });
    if (task.createdBy) {
      this._messageBus?.send("system", task.createdBy, {
        type: "task.result",
        taskId,
        status: "completed",
        result,
      });
    }
    return { success: true };
  }

  fail(taskId, agentId, error) {
    const task = this._tasks.get(taskId);
    if (!task) return { success: false, error: "task_not_found" };
    if (task.claimedBy !== agentId) return { success: false, error: "not_task_owner" };
    if (task.status !== "running") return { success: false, error: "task_not_running" };

    task.status = "failed";
    task.error = error;
    task.completedAt = Date.now();
    this._persist();

    this._emit("task.failed", { taskId, failedBy: agentId, error });
    if (task.createdBy) {
      this._messageBus?.send("system", task.createdBy, {
        type: "task.result",
        taskId,
        status: "failed",
        error,
      });
    }
    return { success: true };
  }

  progress(taskId, agentId, update) {
    const task = this._tasks.get(taskId);
    if (!task) return { success: false, error: "task_not_found" };
    if (task.claimedBy !== agentId) return { success: false, error: "not_task_owner" };

    this._emit("task.progress", { taskId, agentId, update });
    if (task.createdBy) {
      this._messageBus?.send("system", task.createdBy, {
        type: "task.progress",
        taskId,
        update,
      });
    }
    return { success: true };
  }

  getTask(taskId) {
    return this._tasks.get(taskId) || null;
  }

  listPending(filter = {}) {
    let tasks = [...this._tasks.values()].filter(t => t.status === "pending" || t.status === "assigned");
    if (filter.type) tasks = tasks.filter(t => t.type === filter.type);
    if (filter.capability) tasks = tasks.filter(t => !t.requiredCapability || t.requiredCapability === filter.capability);
    if (filter.priority) tasks = tasks.filter(t => t.priority === filter.priority);
    return tasks;
  }

  listByAgent(agentId) {
    return [...this._tasks.values()].filter(
      t => t.claimedBy === agentId || t.createdBy === agentId || t.assignedTo === agentId
    );
  }

  listAll(filter = {}) {
    let tasks = [...this._tasks.values()];
    if (filter.status) tasks = tasks.filter(t => t.status === filter.status);
    if (filter.type) tasks = tasks.filter(t => t.type === filter.type);
    if (filter.limit) tasks = tasks.slice(-filter.limit);
    return tasks;
  }

  cancel(taskId, agentId) {
    const task = this._tasks.get(taskId);
    if (!task) return { success: false, error: "task_not_found" };
    if (task.createdBy !== agentId && task.claimedBy !== agentId) {
      return { success: false, error: "not_authorized" };
    }
    if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
      return { success: false, error: "task_already_terminal" };
    }

    task.status = "cancelled";
    task.completedAt = Date.now();
    this._persist();
    this._emit("task.cancelled", { taskId, cancelledBy: agentId });
    return { success: true };
  }

  cleanup(maxAgeMs = 3600_000) {
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    for (const [id, task] of this._tasks) {
      if (task.completedAt && task.completedAt < cutoff) {
        this._tasks.delete(id);
        removed++;
      }
    }
    if (removed > 0) this._persist();
    return removed;
  }

  get stats() {
    const counts = { pending: 0, assigned: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
    for (const task of this._tasks.values()) {
      counts[task.status] = (counts[task.status] || 0) + 1;
    }
    return { total: this._tasks.size, ...counts };
  }

  destroy() {
    this._persistence.flush();
  }
}
