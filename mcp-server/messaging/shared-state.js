import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { Persistence } from "./persistence.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(__dirname, "..", "data", "shared-state.json");

const MAX_KEYS = 10_000;

export class SharedStateStore {
  constructor(messageBus) {
    this._state = new Map();
    this._messageBus = messageBus;
    this._persistence = new Persistence();
    this._load();
  }

  _load() {
    const data = this._persistence.loadJSON(DATA_FILE);
    if (data && typeof data === "object") {
      for (const [compositeKey, entry] of Object.entries(data)) {
        this._state.set(compositeKey, entry);
      }
    }
  }

  _persist() {
    const data = {};
    for (const [key, entry] of this._state) {
      data[key] = entry;
    }
    this._persistence.saveJSONDebounced(DATA_FILE, data);
  }

  _key(namespace, key) {
    return `${namespace}:${key}`;
  }

  _notify(namespace, key, entry) {
    if (this._messageBus) {
      this._messageBus.broadcast("system", `state.changed.${namespace}.${key}`, {
        namespace,
        key,
        value: entry.value,
        version: entry.version,
        updatedBy: entry.updatedBy,
        updatedAt: entry.updatedAt,
      });
    }
  }

  get(namespace, key) {
    const entry = this._state.get(this._key(namespace, key));
    if (!entry) return null;
    return {
      key,
      namespace,
      value: entry.value,
      version: entry.version,
      updatedBy: entry.updatedBy,
      updatedAt: entry.updatedAt,
    };
  }

  set(namespace, key, value, agentId, expectedVersion) {
    const compositeKey = this._key(namespace, key);
    const existing = this._state.get(compositeKey);

    if (expectedVersion !== undefined && expectedVersion !== null) {
      const currentVersion = existing ? existing.version : 0;
      if (currentVersion !== expectedVersion) {
        return {
          success: false,
          error: "version_conflict",
          currentVersion,
          expectedVersion,
        };
      }
    }

    if (!existing && this._state.size >= MAX_KEYS) {
      return {
        success: false,
        error: "max_keys_exceeded",
        limit: MAX_KEYS,
      };
    }

    const version = existing ? existing.version + 1 : 1;
    const entry = {
      key,
      namespace,
      value,
      version,
      updatedBy: agentId,
      updatedAt: Date.now(),
    };

    this._state.set(compositeKey, entry);
    this._persist();
    this._notify(namespace, key, entry);

    return { success: true, version };
  }

  delete(namespace, key, agentId) {
    const compositeKey = this._key(namespace, key);
    const existing = this._state.get(compositeKey);
    if (!existing) return false;

    this._state.delete(compositeKey);
    this._persist();

    if (this._messageBus) {
      this._messageBus.broadcast("system", `state.changed.${namespace}.${key}`, {
        namespace,
        key,
        value: null,
        version: existing.version + 1,
        updatedBy: agentId,
        updatedAt: Date.now(),
        deleted: true,
      });
    }

    return true;
  }

  list(namespace) {
    const results = [];
    for (const entry of this._state.values()) {
      if (!namespace || entry.namespace === namespace) {
        results.push({
          key: entry.key,
          namespace: entry.namespace,
          version: entry.version,
          updatedBy: entry.updatedBy,
          updatedAt: entry.updatedAt,
        });
      }
    }
    return results;
  }

  watch(agentId, namespace, keyPattern) {
    if (!this._messageBus) return;
    const topic = keyPattern
      ? `state.changed.${namespace}.${keyPattern}`
      : `state.changed.${namespace}.*`;
    this._messageBus.subscribe(agentId, topic);
    return topic;
  }

  get count() {
    return this._state.size;
  }

  get namespaces() {
    const ns = new Set();
    for (const entry of this._state.values()) {
      ns.add(entry.namespace);
    }
    return [...ns];
  }

  destroy() {
    this._persistence.flush();
  }
}
