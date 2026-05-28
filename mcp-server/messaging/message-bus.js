import { randomBytes } from "crypto";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { Persistence } from "./persistence.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PENDING_FILE = join(__dirname, "..", "data", "pending-messages.json");

const MAX_QUEUE_PER_AGENT = 100;
const DEFAULT_TTL_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class MessageBus {
  constructor() {
    this._subscriptions = new Map();
    this._deliveryCallbacks = new Map();
    this._pendingQueues = new Map();
    this._pendingRequests = new Map();
    this._persistence = new Persistence();
    this._loadPending();
  }

  _loadPending() {
    const data = this._persistence.loadJSON(PENDING_FILE);
    if (data && typeof data === "object") {
      for (const [agentId, messages] of Object.entries(data)) {
        if (Array.isArray(messages) && messages.length > 0) {
          this._pendingQueues.set(agentId, messages);
        }
      }
    }
  }

  _persistPending() {
    const data = {};
    for (const [agentId, queue] of this._pendingQueues) {
      if (queue.length > 0) data[agentId] = queue;
    }
    this._persistence.saveJSONDebounced(PENDING_FILE, data);
  }

  _makeId() {
    return `msg_${randomBytes(8).toString("hex")}`;
  }

  _topicMatches(pattern, topic) {
    if (pattern === topic) return true;
    if (pattern.endsWith(".*")) {
      const prefix = pattern.slice(0, -2);
      return topic === prefix || topic.startsWith(prefix + ".");
    }
    if (pattern === "*") return true;
    return false;
  }

  _isExpired(msg) {
    return msg.ttl && Date.now() - msg.timestamp > msg.ttl;
  }

  _deliver(agentId, message) {
    const cb = this._deliveryCallbacks.get(agentId);
    if (cb) {
      try { cb(message); } catch {}
      return true;
    }
    let queue = this._pendingQueues.get(agentId);
    if (!queue) {
      queue = [];
      this._pendingQueues.set(agentId, queue);
    }
    if (queue.length >= MAX_QUEUE_PER_AGENT) {
      queue.shift();
    }
    queue.push(message);
    this._persistPending();
    return false;
  }

  registerDelivery(agentId, callback) {
    this._deliveryCallbacks.set(agentId, callback);
    this._drainPending(agentId);
  }

  unregisterDelivery(agentId) {
    this._deliveryCallbacks.delete(agentId);
  }

  _drainPending(agentId) {
    const queue = this._pendingQueues.get(agentId);
    if (!queue || queue.length === 0) return;

    const cb = this._deliveryCallbacks.get(agentId);
    if (!cb) return;

    const remaining = [];
    for (const msg of queue) {
      if (this._isExpired(msg)) continue;
      try { cb(msg); } catch { remaining.push(msg); }
    }

    if (remaining.length > 0) {
      this._pendingQueues.set(agentId, remaining);
    } else {
      this._pendingQueues.delete(agentId);
    }
    this._persistPending();
  }

  subscribe(agentId, topicPattern) {
    let agents = this._subscriptions.get(topicPattern);
    if (!agents) {
      agents = new Set();
      this._subscriptions.set(topicPattern, agents);
    }
    agents.add(agentId);
  }

  unsubscribe(agentId, topicPattern) {
    const agents = this._subscriptions.get(topicPattern);
    if (!agents) return false;
    const removed = agents.delete(agentId);
    if (agents.size === 0) this._subscriptions.delete(topicPattern);
    return removed;
  }

  unsubscribeAll(agentId) {
    for (const [pattern, agents] of this._subscriptions) {
      agents.delete(agentId);
      if (agents.size === 0) this._subscriptions.delete(pattern);
    }
  }

  getSubscriptions(agentId) {
    const topics = [];
    for (const [pattern, agents] of this._subscriptions) {
      if (agents.has(agentId)) topics.push(pattern);
    }
    return topics;
  }

  broadcast(fromAgentId, topic, payload, ttl = DEFAULT_TTL_MS) {
    const message = {
      id: this._makeId(),
      type: "broadcast",
      from: fromAgentId,
      to: null,
      topic,
      payload,
      correlationId: null,
      timestamp: Date.now(),
      ttl,
    };

    const delivered = new Set();
    for (const [pattern, agents] of this._subscriptions) {
      if (this._topicMatches(pattern, topic)) {
        for (const agentId of agents) {
          if (agentId !== fromAgentId && !delivered.has(agentId)) {
            delivered.add(agentId);
            this._deliver(agentId, message);
          }
        }
      }
    }

    return message;
  }

  send(fromAgentId, toAgentId, payload, ttl = DEFAULT_TTL_MS) {
    const message = {
      id: this._makeId(),
      type: "direct",
      from: fromAgentId,
      to: toAgentId,
      topic: null,
      payload,
      correlationId: null,
      timestamp: Date.now(),
      ttl,
    };

    this._deliver(toAgentId, message);
    return message;
  }

  request(fromAgentId, toAgentId, payload, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    const message = {
      id: this._makeId(),
      type: "request",
      from: fromAgentId,
      to: toAgentId,
      topic: null,
      payload,
      correlationId: null,
      timestamp: Date.now(),
      ttl: timeoutMs,
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingRequests.delete(message.id);
        reject(new Error(`Request ${message.id} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this._pendingRequests.set(message.id, { resolve, reject, timer });
      this._deliver(toAgentId, message);
    });
  }

  respond(fromAgentId, correlationId, payload) {
    const message = {
      id: this._makeId(),
      type: "response",
      from: fromAgentId,
      to: null,
      topic: null,
      payload,
      correlationId,
      timestamp: Date.now(),
      ttl: DEFAULT_TTL_MS,
    };

    const pending = this._pendingRequests.get(correlationId);
    if (pending) {
      clearTimeout(pending.timer);
      this._pendingRequests.delete(correlationId);
      pending.resolve(message);
      return message;
    }

    return message;
  }

  getBufferedMessages(agentId, filter = {}) {
    const queue = this._pendingQueues.get(agentId) || [];
    let messages = queue.filter(m => !this._isExpired(m));

    if (filter.topic) {
      messages = messages.filter(m => m.topic && this._topicMatches(filter.topic, m.topic));
    }
    if (filter.limit) {
      messages = messages.slice(-filter.limit);
    }

    if (!filter.peek) {
      if (filter.topic) {
        const ids = new Set(messages.map(m => m.id));
        this._pendingQueues.set(agentId, queue.filter(m => !ids.has(m.id)));
      } else if (filter.limit && messages.length < queue.length) {
        this._pendingQueues.set(agentId, queue.slice(0, queue.length - messages.length));
      } else {
        this._pendingQueues.delete(agentId);
      }
      this._persistPending();
    }

    return messages;
  }

  get stats() {
    let totalQueued = 0;
    for (const queue of this._pendingQueues.values()) {
      totalQueued += queue.length;
    }
    return {
      subscriptionCount: this._subscriptions.size,
      deliveryCallbackCount: this._deliveryCallbacks.size,
      pendingRequestCount: this._pendingRequests.size,
      totalQueuedMessages: totalQueued,
      agentsWithQueues: this._pendingQueues.size,
    };
  }

  destroy() {
    for (const [, { timer }] of this._pendingRequests) {
      clearTimeout(timer);
    }
    this._pendingRequests.clear();
    this._persistence.flush();
  }
}
