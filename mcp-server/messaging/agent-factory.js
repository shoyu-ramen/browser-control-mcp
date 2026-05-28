import { randomBytes } from "crypto";

const BLUEPRINTS = {
  navigator: {
    role: "browser",
    capabilities: ["browse", "navigate", "screenshot"],
    subscriptions: ["task.*", "browser.navigation"],
    description: "Navigates pages, waits for loads, takes screenshots",
    taskTypes: ["browser"],
  },
  scraper: {
    role: "worker",
    capabilities: ["scrape", "extract"],
    subscriptions: ["task.*", "browser.navigation"],
    description: "Extracts text, links, tables, and structured data from pages",
    taskTypes: ["scrape"],
  },
  "form-filler": {
    role: "browser",
    capabilities: ["browse", "form", "automate"],
    subscriptions: ["task.*", "browser.navigation"],
    description: "Detects and fills forms, handles submissions",
    taskTypes: ["browser"],
  },
  monitor: {
    role: "analyzer",
    capabilities: ["monitor", "analyze"],
    subscriptions: ["browser.*", "workflow.*", "task.*"],
    description: "Watches browser events, console logs, network activity",
    taskTypes: ["analyze"],
  },
  analyzer: {
    role: "analyzer",
    capabilities: ["analyze", "transform"],
    subscriptions: ["task.*", "state.changed.*"],
    description: "Processes extracted data — summarize, filter, compare",
    taskTypes: ["analyze", "transform"],
  },
  orchestrator: {
    role: "orchestrator",
    capabilities: ["plan", "delegate"],
    subscriptions: ["task.*", "agent.*", "workflow.*"],
    description: "Plans multi-step workflows and delegates to other agents",
    taskTypes: [],
  },
  authenticator: {
    role: "browser",
    capabilities: ["browse", "auth", "form"],
    subscriptions: ["task.*", "browser.navigation"],
    description: "Handles login, OAuth, CAPTCHA, and session management",
    taskTypes: ["browser"],
  },
  pipeline: {
    role: "worker",
    capabilities: ["transform", "pipeline"],
    subscriptions: ["task.*", "state.changed.*"],
    description: "Receives data from upstream agents, transforms, passes downstream",
    taskTypes: ["transform"],
  },
};

const TEAMS = {
  "scrape-team": {
    description: "Navigate pages and extract structured data",
    agents: [
      { blueprint: "orchestrator", name: "scrape-orchestrator" },
      { blueprint: "navigator",    name: "scrape-navigator" },
      { blueprint: "scraper",      name: "scrape-extractor" },
      { blueprint: "analyzer",     name: "scrape-analyzer" },
    ],
    pipelineTopics: ["pipeline.scrape"],
  },
  "form-team": {
    description: "Find, fill, and submit forms across pages",
    agents: [
      { blueprint: "orchestrator",  name: "form-orchestrator" },
      { blueprint: "navigator",     name: "form-navigator" },
      { blueprint: "form-filler",   name: "form-agent" },
      { blueprint: "monitor",       name: "form-monitor" },
    ],
    pipelineTopics: ["pipeline.form"],
  },
  "auth-team": {
    description: "Authenticate into sites — login, OAuth, MFA",
    agents: [
      { blueprint: "authenticator", name: "auth-agent" },
      { blueprint: "monitor",       name: "auth-monitor" },
    ],
    pipelineTopics: ["pipeline.auth"],
  },
  "full-stack": {
    description: "Complete browser automation — navigate, auth, scrape, analyze",
    agents: [
      { blueprint: "orchestrator",  name: "stack-orchestrator" },
      { blueprint: "navigator",     name: "stack-navigator" },
      { blueprint: "authenticator", name: "stack-auth" },
      { blueprint: "scraper",       name: "stack-scraper" },
      { blueprint: "form-filler",   name: "stack-form" },
      { blueprint: "analyzer",      name: "stack-analyzer" },
      { blueprint: "monitor",       name: "stack-monitor" },
    ],
    pipelineTopics: ["pipeline.stack"],
  },
  "data-pipeline": {
    description: "Multi-stage data extraction and transformation pipeline",
    agents: [
      { blueprint: "orchestrator", name: "pipe-orchestrator" },
      { blueprint: "scraper",      name: "pipe-extractor" },
      { blueprint: "pipeline",     name: "pipe-transform-1" },
      { blueprint: "pipeline",     name: "pipe-transform-2" },
      { blueprint: "analyzer",     name: "pipe-output" },
    ],
    pipelineTopics: ["pipeline.data"],
  },
};

export class AgentFactory {
  constructor({ registry, messageBus, taskQueue }) {
    this._registry = registry;
    this._messageBus = messageBus;
    this._taskQueue = taskQueue;
    this._spawned = new Map();
  }

  listBlueprints() {
    return Object.entries(BLUEPRINTS).map(([name, bp]) => ({
      name,
      role: bp.role,
      capabilities: bp.capabilities,
      description: bp.description,
    }));
  }

  listTeams() {
    return Object.entries(TEAMS).map(([name, team]) => ({
      name,
      description: team.description,
      agentCount: team.agents.length,
      agents: team.agents.map(a => ({ blueprint: a.blueprint, name: a.name })),
    }));
  }

  spawn(blueprintName, { name, overrides } = {}) {
    const bp = BLUEPRINTS[blueprintName];
    if (!bp) return { success: false, error: "unknown_blueprint", available: Object.keys(BLUEPRINTS) };

    const agentName = name || `${blueprintName}-${randomBytes(3).toString("hex")}`;
    const capabilities = overrides?.capabilities || bp.capabilities;
    const role = overrides?.role || bp.role;
    const subs = overrides?.subscriptions || bp.subscriptions;

    let agent;
    try {
      agent = this._registry.register({
        name: agentName,
        type: "agent-sdk",
        capabilities,
        metadata: {
          role,
          blueprint: blueprintName,
          description: bp.description,
          taskTypes: bp.taskTypes,
          ...(overrides?.metadata || {}),
        },
        transport: "local",
      });
    } catch (e) {
      return { success: false, error: e.message };
    }

    for (const topic of subs) {
      this._messageBus.subscribe(agent.id, topic);
    }

    this._messageBus.registerDelivery(agent.id, () => {});

    this._spawned.set(agent.id, {
      agentId: agent.id,
      name: agentName,
      blueprint: blueprintName,
      subscriptions: subs,
      spawnedAt: Date.now(),
    });

    return { success: true, agentId: agent.id, name: agentName, role, capabilities };
  }

  spawnTeam(teamName, { prefix } = {}) {
    const team = TEAMS[teamName];
    if (!team) return { success: false, error: "unknown_team", available: Object.keys(TEAMS) };

    const teamId = `team_${randomBytes(4).toString("hex")}`;
    const results = [];
    const agentIds = [];

    for (const spec of team.agents) {
      const agentName = prefix
        ? `${prefix}-${spec.name}`
        : spec.name;
      const result = this.spawn(spec.blueprint, { name: agentName });
      results.push(result);
      if (result.success) agentIds.push(result.agentId);
    }

    for (const topic of team.pipelineTopics || []) {
      for (const id of agentIds) {
        this._messageBus.subscribe(id, topic);
      }
    }

    const failed = results.filter(r => !r.success);

    return {
      success: failed.length === 0,
      teamId,
      teamName,
      description: team.description,
      agents: results,
      agentIds,
      failedCount: failed.length,
    };
  }

  despawn(agentId) {
    const record = this._spawned.get(agentId);
    if (!record) return { success: false, error: "not_a_factory_agent" };

    this._messageBus.unsubscribeAll(agentId);
    this._messageBus.unregisterDelivery(agentId);
    this._registry.deregister(agentId);
    this._spawned.delete(agentId);
    return { success: true, name: record.name };
  }

  despawnAll() {
    const ids = [...this._spawned.keys()];
    for (const id of ids) {
      this.despawn(id);
    }
    return { removed: ids.length };
  }

  listSpawned() {
    return [...this._spawned.values()];
  }

  get spawnedCount() {
    return this._spawned.size;
  }

  destroy() {
    this.despawnAll();
  }
}
