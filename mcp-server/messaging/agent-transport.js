import { WebSocketServer } from "ws";

const AGENT_WS_PORT = 7226;
const MAX_AGENTS = 50;
const MAX_PAYLOAD_SIZE = 1_048_576;

export class AgentTransport {
  constructor({ registry, messageBus, sharedState, taskQueue, sendCommand }) {
    this._registry = registry;
    this._messageBus = messageBus;
    this._sharedState = sharedState;
    this._taskQueue = taskQueue;
    this._sendCommand = sendCommand;
    this._sockets = new Map();
    this._wss = null;
  }

  start() {
    this._wss = new WebSocketServer({ port: AGENT_WS_PORT, host: "127.0.0.1" });

    this._wss.on("connection", (socket) => {
      let agentId = null;

      socket.on("message", (raw) => {
        if (raw.length > MAX_PAYLOAD_SIZE) {
          socket.send(JSON.stringify({ type: "error", error: "payload_too_large" }));
          return;
        }

        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        if (msg.type === "register") {
          agentId = this._handleRegister(socket, msg);
          return;
        }

        if (!agentId) {
          socket.send(JSON.stringify({ type: "error", error: "not_registered" }));
          return;
        }

        switch (msg.type) {
          case "heartbeat":
            this._registry.heartbeat(agentId);
            break;
          case "message":
            this._handleMessage(agentId, msg.message);
            break;
          case "subscribe":
            this._messageBus.subscribe(agentId, msg.topic);
            socket.send(JSON.stringify({ type: "subscribed", topic: msg.topic }));
            break;
          case "unsubscribe":
            this._messageBus.unsubscribe(agentId, msg.topic);
            socket.send(JSON.stringify({ type: "unsubscribed", topic: msg.topic }));
            break;
          case "browser_command":
            this._handleBrowserCommand(socket, agentId, msg);
            break;
          case "task_submit":
            this._handleTaskSubmit(socket, agentId, msg);
            break;
          case "task_claim":
            this._handleTaskClaim(socket, agentId, msg);
            break;
          case "task_complete":
            this._handleTaskComplete(socket, agentId, msg);
            break;
          case "task_fail":
            this._handleTaskFail(socket, agentId, msg);
            break;
          case "task_list":
            this._handleTaskList(socket, agentId, msg);
            break;
          case "state_get":
            this._handleStateGet(socket, msg);
            break;
          case "state_set":
            this._handleStateSet(socket, agentId, msg);
            break;
          case "state_delete":
            this._handleStateDelete(socket, agentId, msg);
            break;
          case "state_list":
            this._handleStateList(socket, msg);
            break;
          case "state_watch":
            this._handleStateWatch(agentId, msg);
            break;
          case "deregister":
            this._cleanup(agentId);
            agentId = null;
            socket.send(JSON.stringify({ type: "deregistered" }));
            break;
        }
      });

      socket.on("close", () => {
        if (agentId) this._cleanup(agentId);
      });

      socket.on("error", () => {
        if (agentId) this._cleanup(agentId);
      });
    });

    this._wss.on("error", (err) => {
      process.stderr.write(`[MCP] Agent transport error: ${err.message}\n`);
    });

    process.stderr.write(`[MCP] Agent transport listening on port ${AGENT_WS_PORT}\n`);
  }

  _handleRegister(socket, msg) {
    if (this._registry.onlineCount >= MAX_AGENTS) {
      socket.send(JSON.stringify({ type: "error", error: "max_agents_exceeded", limit: MAX_AGENTS }));
      return null;
    }

    try {
      const agent = this._registry.register({
        name: msg.name,
        type: msg.agentType || "external",
        capabilities: msg.capabilities || [],
        metadata: msg.metadata || {},
        id: msg.id || undefined,
        transport: "ws",
        endpoint: socket,
      });

      const agentId = agent.id;
      this._sockets.set(agentId, socket);

      this._messageBus.registerDelivery(agentId, (message) => {
        if (socket.readyState === 1) {
          socket.send(JSON.stringify({ type: "message", message }));
        }
      });

      socket.send(JSON.stringify({
        type: "registered",
        agentId,
        name: agent.name,
        serverTime: Date.now(),
      }));

      return agentId;
    } catch (e) {
      socket.send(JSON.stringify({ type: "error", error: e.message }));
      return null;
    }
  }

  _handleMessage(fromAgentId, message) {
    if (!message) return;

    if (message.topic) {
      this._messageBus.broadcast(fromAgentId, message.topic, message.payload);
    } else if (message.to) {
      if (message.correlationId) {
        this._messageBus.respond(fromAgentId, message.correlationId, message.payload);
      } else {
        this._messageBus.send(fromAgentId, message.to, message.payload);
      }
    }
  }

  async _handleBrowserCommand(socket, agentId, msg) {
    const perms = this._registry.getPermissions(agentId);
    if (!perms || !perms.canBrowse) {
      const browserAgentId = this._registry.getBrowserAgent();
      if (!browserAgentId || browserAgentId === agentId) {
        socket.send(JSON.stringify({ type: "browser_result", requestId: msg.requestId, error: "no_browser_access" }));
        return;
      }
    }

    if (!this._sendCommand) {
      socket.send(JSON.stringify({ type: "browser_result", requestId: msg.requestId, error: "browser_not_available" }));
      return;
    }

    try {
      const result = await this._sendCommand(msg.command, msg.params || {}, msg.timeoutMs || 15000);
      socket.send(JSON.stringify({ type: "browser_result", requestId: msg.requestId, result }));
    } catch (e) {
      socket.send(JSON.stringify({ type: "browser_result", requestId: msg.requestId, error: e.message }));
    }
  }

  _handleTaskSubmit(socket, agentId, msg) {
    const result = this._taskQueue.submit({
      type: msg.taskType,
      description: msg.description,
      params: msg.params,
      requiredCapability: msg.requiredCapability,
      assignTo: msg.assignTo,
      priority: msg.priority,
      createdBy: agentId,
    });
    socket.send(JSON.stringify({ type: "task_result", action: "submit", data: result }));
  }

  _handleTaskClaim(socket, agentId, msg) {
    const result = this._taskQueue.claim(msg.taskId, agentId);
    socket.send(JSON.stringify({ type: "task_result", action: "claim", data: result }));
  }

  _handleTaskComplete(socket, agentId, msg) {
    const result = this._taskQueue.complete(msg.taskId, agentId, msg.result);
    socket.send(JSON.stringify({ type: "task_result", action: "complete", data: result }));
  }

  _handleTaskFail(socket, agentId, msg) {
    const result = this._taskQueue.fail(msg.taskId, agentId, msg.error);
    socket.send(JSON.stringify({ type: "task_result", action: "fail", data: result }));
  }

  _handleTaskList(socket, agentId, msg) {
    let tasks;
    if (msg.filter === "mine") {
      tasks = this._taskQueue.listByAgent(agentId);
    } else if (msg.filter === "pending") {
      tasks = this._taskQueue.listPending({ capability: msg.capability });
    } else {
      tasks = this._taskQueue.listAll({ status: msg.status, type: msg.taskType, limit: msg.limit });
    }
    socket.send(JSON.stringify({ type: "task_result", action: "list", data: tasks }));
  }

  _handleStateGet(socket, msg) {
    const entry = this._sharedState.get(msg.namespace || "global", msg.key);
    socket.send(JSON.stringify({ type: "state_result", data: entry }));
  }

  _handleStateSet(socket, agentId, msg) {
    const result = this._sharedState.set(
      msg.namespace || "global",
      msg.key,
      msg.value,
      agentId,
      msg.expectedVersion
    );
    socket.send(JSON.stringify({ type: "state_result", data: result }));
  }

  _handleStateDelete(socket, agentId, msg) {
    const deleted = this._sharedState.delete(msg.namespace || "global", msg.key, agentId);
    socket.send(JSON.stringify({ type: "state_result", data: { deleted } }));
  }

  _handleStateList(socket, msg) {
    const keys = this._sharedState.list(msg.namespace);
    socket.send(JSON.stringify({ type: "state_result", data: { keys } }));
  }

  _handleStateWatch(agentId, msg) {
    this._sharedState.watch(agentId, msg.namespace || "global", msg.key);
  }

  _cleanup(agentId) {
    this._sockets.delete(agentId);
    this._messageBus.unregisterDelivery(agentId);
    this._messageBus.unsubscribeAll(agentId);
    const agent = this._registry.getWithEndpoint(agentId);
    if (agent) {
      agent.status = "offline";
      agent.endpoint = null;
    }
  }

  stop() {
    if (this._wss) {
      this._wss.close();
      this._wss = null;
    }
  }
}
