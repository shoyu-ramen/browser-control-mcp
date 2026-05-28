import { randomBytes } from "crypto";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { Persistence } from "./persistence.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(__dirname, "..", "data", "agents.json");

const HEARTBEAT_TIMEOUT_MS = 90_000;
const REMOVAL_TIMEOUT_MS = 300_000;

const VALID_ROLES = ["orchestrator", "browser", "worker", "analyzer"];

const ROLE_PERMISSIONS = {
  orchestrator: { canDelegate: true, canBrowse: false, canClaim: false },
  browser:      { canDelegate: true, canBrowse: true,  canClaim: true },
  worker:       { canDelegate: false, canBrowse: false, canClaim: true },
  analyzer:     { canDelegate: false, canBrowse: false, canClaim: true },
};

export class AgentRegistry {
  constructor(messageBus) {
    this._agents = new Map();
    this._persistence = new Persistence();
    this._messageBus = messageBus;
    this._sweepInterval = null;
    this._load();
    this._startSweep();
  }

  _load() {
    const data = this._persistence.loadJSON(DATA_FILE);
    if (Array.isArray(data)) {
      for (const agent of data) {
        agent.status = "offline";
        agent.endpoint = null;
        this._agents.set(agent.id, agent);
      }
    }
  }

  _persist() {
    const serializable = [...this._agents.values()].map(a => {
      const { endpoint, ...rest } = a;
      return rest;
    });
    this._persistence.saveJSON(DATA_FILE, serializable);
  }

  _startSweep() {
    this._sweepInterval = setInterval(() => this._sweep(), 30_000);
    if (this._sweepInterval.unref) this._sweepInterval.unref();
  }

  _sweep() {
    const now = Date.now();
    for (const [id, agent] of this._agents) {
      if (agent.transport === "local") continue;

      if (agent.status === "online" && now - agent.lastHeartbeatAt > HEARTBEAT_TIMEOUT_MS) {
        agent.status = "offline";
        this._emit("agent.status", { agentId: id, status: "offline" });
        this._persist();
      }

      if (agent.status === "offline" && now - agent.lastHeartbeatAt > REMOVAL_TIMEOUT_MS) {
        this._agents.delete(id);
        this._emit("agent.left", { agentId: id, name: agent.name });
        this._persist();
      }
    }
  }

  _emit(topic, data) {
    if (this._messageBus) {
      this._messageBus.broadcast("system", topic, data);
    }
  }

  register({ name, type, capabilities, metadata, id: requestedId, transport, endpoint }) {
    if (requestedId && this._agents.has(requestedId)) {
      const existing = this._agents.get(requestedId);
      existing.name = name || existing.name;
      existing.type = type || existing.type;
      existing.capabilities = capabilities || existing.capabilities;
      existing.metadata = { ...existing.metadata, ...metadata };
      existing.status = "online";
      existing.transport = transport || existing.transport;
      existing.endpoint = endpoint || null;
      existing.lastHeartbeatAt = Date.now();
      this._persist();
      this._emit("agent.joined", { agentId: existing.id, name: existing.name, reconnect: true });
      return existing;
    }

    const nameConflict = [...this._agents.values()].find(
      a => a.name === name && a.status === "online"
    );
    if (nameConflict) {
      throw new Error(`Agent name "${name}" is already in use by ${nameConflict.id}`);
    }

    const id = `agent_${randomBytes(8).toString("hex")}`;
    const role = metadata?.role && VALID_ROLES.includes(metadata.role) ? metadata.role : "worker";
    const agent = {
      id,
      name: name || id,
      type: type || "external",
      role,
      capabilities: capabilities || [],
      metadata: metadata || {},
      status: "online",
      transport: transport || "ws",
      registeredAt: Date.now(),
      lastHeartbeatAt: Date.now(),
      endpoint: endpoint || null,
    };

    this._agents.set(id, agent);
    this._persist();
    this._emit("agent.joined", { agentId: id, name: agent.name, reconnect: false });
    return agent;
  }

  deregister(agentId) {
    const agent = this._agents.get(agentId);
    if (!agent) return false;
    const name = agent.name;
    this._agents.delete(agentId);
    this._persist();
    this._emit("agent.left", { agentId, name });
    return true;
  }

  heartbeat(agentId) {
    const agent = this._agents.get(agentId);
    if (!agent) return false;
    agent.lastHeartbeatAt = Date.now();
    if (agent.status !== "online") {
      agent.status = "online";
      this._emit("agent.status", { agentId, status: "online" });
      this._persist();
    }
    return true;
  }

  get(agentId) {
    const agent = this._agents.get(agentId);
    if (!agent) return null;
    const { endpoint, ...info } = agent;
    return info;
  }

  getWithEndpoint(agentId) {
    return this._agents.get(agentId) || null;
  }

  findByName(name) {
    for (const agent of this._agents.values()) {
      if (agent.name === name) {
        const { endpoint, ...info } = agent;
        return info;
      }
    }
    return null;
  }

  list(filter = {}) {
    let agents = [...this._agents.values()];

    if (filter.type) agents = agents.filter(a => a.type === filter.type);
    if (filter.status) agents = agents.filter(a => a.status === filter.status);
    if (filter.capability) {
      agents = agents.filter(a => a.capabilities.includes(filter.capability));
    }

    return agents.map(({ endpoint, ...rest }) => rest);
  }

  getPermissions(agentId) {
    const agent = this._agents.get(agentId);
    if (!agent) return null;
    return ROLE_PERMISSIONS[agent.role] || ROLE_PERMISSIONS.worker;
  }

  findByRole(role) {
    return [...this._agents.values()]
      .filter(a => a.role === role && a.status === "online")
      .map(({ endpoint, ...rest }) => rest);
  }

  getBrowserAgent() {
    for (const agent of this._agents.values()) {
      if (agent.role === "browser" && agent.status === "online") {
        return agent.id;
      }
    }
    return null;
  }

  get count() {
    return this._agents.size;
  }

  get onlineCount() {
    return [...this._agents.values()].filter(a => a.status === "online").length;
  }

  destroy() {
    if (this._sweepInterval) {
      clearInterval(this._sweepInterval);
      this._sweepInterval = null;
    }
  }
}
