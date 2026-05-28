import { z } from "zod";

export function registerNetworkTools(server, { registry, messageBus, sharedState, taskQueue, agentFactory, localAgentId, sendCommand }) {

  // --- Registry ---

  server.tool(
    "network_register",
    "Register the local session as a named agent on the inter-agent network. Role determines permissions: 'orchestrator' can delegate tasks but not claim; 'browser' can delegate AND execute browser commands; 'worker' can claim and execute tasks; 'analyzer' can claim tasks (data analysis focus). Returns the assigned agent ID.",
    {
      name: z.string().describe("Human-readable agent name (must be unique among online agents)"),
      role: z.enum(["orchestrator", "browser", "worker", "analyzer"]).optional().describe("Agent role (default: browser for local session). orchestrator=delegate, browser=delegate+browse, worker=claim tasks, analyzer=claim tasks"),
      type: z.enum(["claude-code", "agent-sdk", "extension", "external"]).optional().describe("Agent type (default: claude-code)"),
      capabilities: z.array(z.string()).optional().describe("List of capabilities this agent provides (e.g. 'browse', 'scrape', 'analyze')"),
      metadata: z.record(z.any()).optional().describe("Arbitrary metadata (version, description, etc.)"),
    },
    async ({ name, role, type, capabilities, metadata }) => {
      try {
        const agent = registry.register({
          name,
          type: type || "claude-code",
          capabilities: capabilities || [],
          metadata: { ...metadata, role: role || "browser" },
          id: localAgentId(),
          transport: "local",
        });
        return { content: [{ type: "text", text: JSON.stringify(agent, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "network_discover",
    "List all agents registered on the inter-agent network. Filter by type, capability, status, or role.",
    {
      type: z.enum(["claude-code", "agent-sdk", "extension", "external"]).optional().describe("Filter by agent type"),
      role: z.enum(["orchestrator", "browser", "worker", "analyzer"]).optional().describe("Filter by agent role"),
      capability: z.string().optional().describe("Filter to agents with this capability"),
      status: z.enum(["online", "offline"]).optional().describe("Filter by status"),
    },
    async ({ type, role, capability, status }) => {
      let agents = registry.list({ type, capability, status });
      if (role) agents = agents.filter(a => a.role === role);
      return { content: [{ type: "text", text: JSON.stringify({ count: agents.length, agents }, null, 2) }] };
    }
  );

  server.tool(
    "network_agent_info",
    "Get detailed information about a specific agent by ID or name.",
    {
      agentId: z.string().optional().describe("Agent ID"),
      name: z.string().optional().describe("Agent name (alternative to ID)"),
    },
    async ({ agentId, name }) => {
      const agent = agentId ? registry.get(agentId) : registry.findByName(name);
      if (!agent) {
        return { content: [{ type: "text", text: `Agent not found` }], isError: true };
      }
      return { content: [{ type: "text", text: JSON.stringify(agent, null, 2) }] };
    }
  );

  server.tool(
    "network_deregister",
    "Remove the local agent from the network registry.",
    {},
    async () => {
      const id = localAgentId();
      if (!id) return { content: [{ type: "text", text: "No local agent registered" }], isError: true };
      const removed = registry.deregister(id);
      return { content: [{ type: "text", text: removed ? "Deregistered" : "Agent not found" }] };
    }
  );

  // --- Messaging ---

  server.tool(
    "network_send_message",
    "Send a direct message to a specific agent by ID. Use expectResponse=true to block until the target agent replies (with timeout).",
    {
      to: z.string().describe("Target agent ID"),
      payload: z.any().describe("Message payload (any JSON)"),
      expectResponse: z.boolean().optional().describe("Block and wait for a response (default false)"),
      timeoutMs: z.number().optional().describe("Response timeout in ms (default 30000, only used with expectResponse)"),
    },
    async ({ to, payload, expectResponse, timeoutMs }) => {
      const fromId = localAgentId();
      if (!fromId) return { content: [{ type: "text", text: "Register first with network_register" }], isError: true };

      if (expectResponse) {
        try {
          const response = await messageBus.request(fromId, to, payload, timeoutMs || 30000);
          return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        } catch (e) {
          return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
        }
      }

      const msg = messageBus.send(fromId, to, payload);
      return { content: [{ type: "text", text: JSON.stringify({ sent: true, messageId: msg.id }, null, 2) }] };
    }
  );

  server.tool(
    "network_broadcast",
    "Publish a message to a topic. All agents subscribed to matching topics will receive it.",
    {
      topic: z.string().describe("Topic name (dot-delimited, e.g. 'task.complete', 'browser.navigation')"),
      payload: z.any().describe("Message payload (any JSON)"),
    },
    async ({ topic, payload }) => {
      const fromId = localAgentId();
      if (!fromId) return { content: [{ type: "text", text: "Register first with network_register" }], isError: true };

      const msg = messageBus.broadcast(fromId, topic, payload);
      return { content: [{ type: "text", text: JSON.stringify({ broadcast: true, messageId: msg.id, topic }, null, 2) }] };
    }
  );

  server.tool(
    "network_subscribe",
    "Subscribe to a topic to receive broadcast messages. Use '*' suffix for prefix matching (e.g. 'task.*' matches 'task.complete' and 'task.started').",
    {
      topic: z.string().describe("Topic pattern to subscribe to"),
    },
    async ({ topic }) => {
      const id = localAgentId();
      if (!id) return { content: [{ type: "text", text: "Register first with network_register" }], isError: true };

      messageBus.subscribe(id, topic);
      return { content: [{ type: "text", text: `Subscribed to "${topic}"` }] };
    }
  );

  server.tool(
    "network_unsubscribe",
    "Unsubscribe from a topic.",
    {
      topic: z.string().describe("Topic pattern to unsubscribe from"),
    },
    async ({ topic }) => {
      const id = localAgentId();
      if (!id) return { content: [{ type: "text", text: "Register first with network_register" }], isError: true };

      const removed = messageBus.unsubscribe(id, topic);
      return { content: [{ type: "text", text: removed ? `Unsubscribed from "${topic}"` : `Not subscribed to "${topic}"` }] };
    }
  );

  server.tool(
    "network_get_messages",
    "Retrieve buffered incoming messages (direct messages and subscribed broadcasts). By default, messages are removed from the buffer after retrieval. Use peek=true to view without removing.",
    {
      limit: z.number().optional().describe("Max messages to return"),
      topic: z.string().optional().describe("Filter by topic (for broadcast messages)"),
      peek: z.boolean().optional().describe("View without removing (default false)"),
    },
    async ({ limit, topic, peek }) => {
      const id = localAgentId();
      if (!id) return { content: [{ type: "text", text: "Register first with network_register" }], isError: true };

      const messages = messageBus.getBufferedMessages(id, { limit, topic, peek });
      return { content: [{ type: "text", text: JSON.stringify({ count: messages.length, messages }, null, 2) }] };
    }
  );

  server.tool(
    "network_respond",
    "Send a response to a received request message. Link it to the original request via correlationId (the original message's ID).",
    {
      correlationId: z.string().describe("The ID of the request message you are responding to"),
      payload: z.any().describe("Response payload (any JSON)"),
    },
    async ({ correlationId, payload }) => {
      const fromId = localAgentId();
      if (!fromId) return { content: [{ type: "text", text: "Register first with network_register" }], isError: true };

      const msg = messageBus.respond(fromId, correlationId, payload);
      return { content: [{ type: "text", text: JSON.stringify({ responded: true, messageId: msg.id }, null, 2) }] };
    }
  );

  // --- Shared State ---

  server.tool(
    "network_state_get",
    "Read a value from the shared state store. State is shared across all agents on the network.",
    {
      namespace: z.string().optional().describe("State namespace (default: 'global')"),
      key: z.string().describe("Key to retrieve"),
    },
    async ({ namespace, key }) => {
      const entry = sharedState.get(namespace || "global", key);
      if (!entry) return { content: [{ type: "text", text: `Key "${key}" not found in namespace "${namespace || "global"}"` }] };
      return { content: [{ type: "text", text: JSON.stringify(entry, null, 2) }] };
    }
  );

  server.tool(
    "network_state_set",
    "Write a value to the shared state store. Use expectedVersion for optimistic concurrency (CAS) — the write only succeeds if the current version matches. Omit expectedVersion for last-writer-wins.",
    {
      namespace: z.string().optional().describe("State namespace (default: 'global')"),
      key: z.string().describe("Key to set"),
      value: z.any().describe("Value to store (any JSON)"),
      expectedVersion: z.number().optional().describe("Expected current version for CAS write (omit for last-writer-wins)"),
    },
    async ({ namespace, key, value, expectedVersion }) => {
      const agentId = localAgentId();
      if (!agentId) return { content: [{ type: "text", text: "Register first with network_register" }], isError: true };

      const result = sharedState.set(namespace || "global", key, value, agentId, expectedVersion);
      if (!result.success) {
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: true };
      }
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "network_state_delete",
    "Delete a key from the shared state store.",
    {
      namespace: z.string().optional().describe("State namespace (default: 'global')"),
      key: z.string().describe("Key to delete"),
    },
    async ({ namespace, key }) => {
      const agentId = localAgentId();
      if (!agentId) return { content: [{ type: "text", text: "Register first with network_register" }], isError: true };

      const deleted = sharedState.delete(namespace || "global", key, agentId);
      return { content: [{ type: "text", text: deleted ? `Deleted "${key}"` : `Key "${key}" not found` }] };
    }
  );

  server.tool(
    "network_state_list",
    "List all keys in the shared state store, optionally filtered by namespace.",
    {
      namespace: z.string().optional().describe("Filter by namespace"),
    },
    async ({ namespace }) => {
      const keys = sharedState.list(namespace);
      return { content: [{ type: "text", text: JSON.stringify({ count: keys.length, keys }, null, 2) }] };
    }
  );

  server.tool(
    "network_state_watch",
    "Subscribe to state changes on a namespace or specific key. Change events will appear in network_get_messages with topics like 'state.changed.global.mykey'.",
    {
      namespace: z.string().optional().describe("Namespace to watch (default: 'global')"),
      key: z.string().optional().describe("Specific key to watch (omit to watch entire namespace)"),
    },
    async ({ namespace, key }) => {
      const agentId = localAgentId();
      if (!agentId) return { content: [{ type: "text", text: "Register first with network_register" }], isError: true };

      const topic = sharedState.watch(agentId, namespace || "global", key);
      return { content: [{ type: "text", text: `Watching state changes on "${topic}"` }] };
    }
  );

  // --- Task Delegation ---

  server.tool(
    "network_task_submit",
    "Submit a task for another agent to pick up. Tasks can target agents by capability, by direct assignment, or be posted for any available worker. Only orchestrator and browser roles can delegate.",
    {
      taskType: z.enum(["browser", "analyze", "scrape", "transform", "generic"]).optional().describe("Task type (default: generic)"),
      description: z.string().describe("Human-readable description of what needs to be done"),
      params: z.record(z.any()).optional().describe("Task parameters (command details, URLs, selectors, data to process, etc.)"),
      requiredCapability: z.string().optional().describe("Only agents with this capability can claim the task"),
      assignTo: z.string().optional().describe("Directly assign to a specific agent ID"),
      priority: z.enum(["low", "normal", "high", "urgent"]).optional().describe("Task priority (default: normal)"),
    },
    async ({ taskType, description, params, requiredCapability, assignTo, priority }) => {
      const agentId = localAgentId();
      if (!agentId) return { content: [{ type: "text", text: "Register first with network_register" }], isError: true };

      const result = taskQueue.submit({
        type: taskType,
        description,
        params,
        requiredCapability,
        assignTo,
        priority,
        createdBy: agentId,
      });
      if (!result.success) return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "network_task_claim",
    "Claim a pending task to work on. Only worker, analyzer, and browser roles can claim tasks. The agent must have the required capability if one is specified.",
    {
      taskId: z.string().describe("Task ID to claim"),
    },
    async ({ taskId }) => {
      const agentId = localAgentId();
      if (!agentId) return { content: [{ type: "text", text: "Register first with network_register" }], isError: true };

      const result = taskQueue.claim(taskId, agentId);
      if (!result.success) return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify({ claimed: true, taskId }, null, 2) }] };
    }
  );

  server.tool(
    "network_task_complete",
    "Mark a claimed task as completed with a result.",
    {
      taskId: z.string().describe("Task ID to complete"),
      result: z.any().describe("Task result (any JSON)"),
    },
    async ({ taskId, result }) => {
      const agentId = localAgentId();
      if (!agentId) return { content: [{ type: "text", text: "Register first with network_register" }], isError: true };

      const res = taskQueue.complete(taskId, agentId, result);
      if (!res.success) return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify({ completed: true, taskId }, null, 2) }] };
    }
  );

  server.tool(
    "network_task_fail",
    "Mark a claimed task as failed with an error description.",
    {
      taskId: z.string().describe("Task ID to fail"),
      error: z.string().describe("Error description"),
    },
    async ({ taskId, error }) => {
      const agentId = localAgentId();
      if (!agentId) return { content: [{ type: "text", text: "Register first with network_register" }], isError: true };

      const res = taskQueue.fail(taskId, agentId, error);
      if (!res.success) return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify({ failed: true, taskId }, null, 2) }] };
    }
  );

  server.tool(
    "network_task_progress",
    "Report progress on a running task. Sends an update to the task creator.",
    {
      taskId: z.string().describe("Task ID"),
      update: z.any().describe("Progress update (percent, status text, partial result, etc.)"),
    },
    async ({ taskId, update }) => {
      const agentId = localAgentId();
      if (!agentId) return { content: [{ type: "text", text: "Register first with network_register" }], isError: true };

      const res = taskQueue.progress(taskId, agentId, update);
      if (!res.success) return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }], isError: true };
      return { content: [{ type: "text", text: "Progress reported" }] };
    }
  );

  server.tool(
    "network_task_list",
    "List tasks — pending tasks available to claim, tasks you created, or tasks assigned to you.",
    {
      filter: z.enum(["pending", "mine", "all"]).optional().describe("Filter: 'pending' for claimable, 'mine' for your tasks, 'all' for everything (default: pending)"),
      status: z.enum(["pending", "assigned", "running", "completed", "failed", "cancelled"]).optional().describe("Filter by status (for 'all' filter)"),
      taskType: z.enum(["browser", "analyze", "scrape", "transform", "generic"]).optional().describe("Filter by task type"),
      limit: z.number().optional().describe("Max results"),
    },
    async ({ filter, status, taskType, limit }) => {
      const agentId = localAgentId();
      const mode = filter || "pending";
      let tasks;

      if (mode === "mine" && agentId) {
        tasks = taskQueue.listByAgent(agentId);
      } else if (mode === "pending") {
        tasks = taskQueue.listPending({ type: taskType });
      } else {
        tasks = taskQueue.listAll({ status, type: taskType, limit });
      }

      return { content: [{ type: "text", text: JSON.stringify({ count: tasks.length, tasks }, null, 2) }] };
    }
  );

  server.tool(
    "network_task_get",
    "Get details of a specific task by ID.",
    {
      taskId: z.string().describe("Task ID"),
    },
    async ({ taskId }) => {
      const task = taskQueue.getTask(taskId);
      if (!task) return { content: [{ type: "text", text: "Task not found" }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(task, null, 2) }] };
    }
  );

  server.tool(
    "network_task_cancel",
    "Cancel a task you created or claimed.",
    {
      taskId: z.string().describe("Task ID to cancel"),
    },
    async ({ taskId }) => {
      const agentId = localAgentId();
      if (!agentId) return { content: [{ type: "text", text: "Register first with network_register" }], isError: true };

      const res = taskQueue.cancel(taskId, agentId);
      if (!res.success) return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify({ cancelled: true, taskId }, null, 2) }] };
    }
  );

  // --- Browser Proxy (for delegated browser operations) ---

  server.tool(
    "network_browser_exec",
    "Execute a browser command on behalf of the network. This is the bridge that lets the local agent fulfill browser tasks submitted by remote agents. Pass the command name and params just like direct browser_* tools.",
    {
      command: z.string().describe("Browser command name (e.g. 'navigate', 'click_element', 'get_page_content', 'take_screenshot')"),
      params: z.record(z.any()).optional().describe("Command parameters"),
      timeoutMs: z.number().optional().describe("Timeout in ms (default 15000)"),
    },
    async ({ command, params, timeoutMs }) => {
      if (!sendCommand) return { content: [{ type: "text", text: "Browser not available" }], isError: true };
      try {
        const result = await sendCommand(command, params || {}, timeoutMs || 15000);
        if (!result) return { content: [{ type: "text", text: "No response from extension" }] };
        if (result.success) {
          const data = typeof result.data === "string" ? result.data : JSON.stringify(result.data, null, 2);
          return { content: [{ type: "text", text: data }] };
        }
        return { content: [{ type: "text", text: `Error: ${result.error}` }], isError: true };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
      }
    }
  );

  // --- Agent Factory ---

  server.tool(
    "network_factory_blueprints",
    "List all available agent blueprints. Each blueprint defines a pre-configured agent role with capabilities, topic subscriptions, and task types. Use with network_factory_spawn to create agents.",
    {},
    async () => {
      const blueprints = agentFactory.listBlueprints();
      return { content: [{ type: "text", text: JSON.stringify({ count: blueprints.length, blueprints }, null, 2) }] };
    }
  );

  server.tool(
    "network_factory_teams",
    "List all available team templates. Each team is a pre-configured group of agents that work together on a specific workflow pattern (scraping, form-filling, auth, full-stack automation, data pipelines).",
    {},
    async () => {
      const teams = agentFactory.listTeams();
      return { content: [{ type: "text", text: JSON.stringify({ count: teams.length, teams }, null, 2) }] };
    }
  );

  server.tool(
    "network_factory_spawn",
    "Spawn a single agent from a blueprint. The agent is registered, subscribed to relevant topics, and ready to receive tasks. Blueprints: navigator, scraper, form-filler, monitor, analyzer, orchestrator, authenticator, pipeline.",
    {
      blueprint: z.string().describe("Blueprint name (e.g. 'scraper', 'navigator', 'orchestrator')"),
      name: z.string().optional().describe("Custom agent name (default: auto-generated from blueprint)"),
      capabilities: z.array(z.string()).optional().describe("Override the blueprint's default capabilities"),
      metadata: z.record(z.any()).optional().describe("Additional metadata to attach to the agent"),
    },
    async ({ blueprint, name, capabilities, metadata }) => {
      const overrides = {};
      if (capabilities) overrides.capabilities = capabilities;
      if (metadata) overrides.metadata = metadata;
      const result = agentFactory.spawn(blueprint, { name, overrides: Object.keys(overrides).length > 0 ? overrides : undefined });
      if (!result.success) return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "network_factory_spawn_team",
    "Spawn an entire team of agents from a team template. All agents are registered, subscribed to relevant topics, and connected via shared pipeline topics. Teams: scrape-team, form-team, auth-team, full-stack, data-pipeline.",
    {
      team: z.string().describe("Team template name (e.g. 'scrape-team', 'full-stack', 'data-pipeline')"),
      prefix: z.string().optional().describe("Prefix for agent names to avoid conflicts when running multiple teams"),
    },
    async ({ team, prefix }) => {
      const result = agentFactory.spawnTeam(team, { prefix });
      if (!result.success && result.failedCount === result.agents?.length) {
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: true };
      }
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "network_factory_despawn",
    "Remove a factory-spawned agent. Unsubscribes from all topics and deregisters from the network.",
    {
      agentId: z.string().describe("Agent ID to remove"),
    },
    async ({ agentId }) => {
      const result = agentFactory.despawn(agentId);
      if (!result.success) return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "network_factory_despawn_all",
    "Remove all factory-spawned agents at once. Useful for resetting the network.",
    {},
    async () => {
      const result = agentFactory.despawnAll();
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "network_factory_list",
    "List all agents currently spawned by the factory, with their blueprint, name, and subscriptions.",
    {},
    async () => {
      const spawned = agentFactory.listSpawned();
      return { content: [{ type: "text", text: JSON.stringify({ count: spawned.length, agents: spawned }, null, 2) }] };
    }
  );

  // --- Meta ---

  server.tool(
    "network_status",
    "Get overall network status: agent count (by role), message queue sizes, task queue stats, shared state stats, factory stats.",
    {},
    async () => {
      const busStats = messageBus.stats;
      const taskStats = taskQueue.stats;
      const agents = registry.list({});
      const roleBreakdown = {};
      for (const a of agents) {
        roleBreakdown[a.role] = (roleBreakdown[a.role] || 0) + 1;
      }
      const status = {
        agents: {
          total: registry.count,
          online: registry.onlineCount,
          byRole: roleBreakdown,
        },
        factory: {
          spawned: agentFactory.spawnedCount,
        },
        tasks: taskStats,
        messageBus: busStats,
        sharedState: {
          keyCount: sharedState.count,
          namespaces: sharedState.namespaces,
        },
        localAgent: localAgentId() || null,
      };
      return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
    }
  );
}
