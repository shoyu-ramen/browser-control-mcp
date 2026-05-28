export class SessionState {
  constructor() {
    this.startedAt = Date.now();
    this.navigationHistory = [];
    this.actionLog = [];
    this.data = new Map();
    this.variables = new Map();
  }

  recordNavigation(url, title) {
    this.navigationHistory.push({ url, title, timestamp: Date.now() });
    if (this.navigationHistory.length > 200) {
      this.navigationHistory = this.navigationHistory.slice(-200);
    }
  }

  recordAction(action) {
    this.actionLog.push({ ...action, timestamp: Date.now() });
    if (this.actionLog.length > 500) {
      this.actionLog = this.actionLog.slice(-500);
    }
  }

  storeData(key, value) {
    this.data.set(key, { value, storedAt: Date.now() });
  }

  getData(key) {
    const entry = this.data.get(key);
    return entry ? entry.value : undefined;
  }

  getAllData() {
    const result = {};
    for (const [key, entry] of this.data) {
      result[key] = entry;
    }
    return result;
  }

  setVariable(name, value) {
    this.variables.set(name, value);
  }

  getVariable(name) {
    return this.variables.get(name);
  }

  getContext() {
    return {
      sessionDurationMs: Date.now() - this.startedAt,
      startedAt: new Date(this.startedAt).toISOString(),
      pagesVisited: this.navigationHistory.length,
      actionsPerformed: this.actionLog.length,
      dataKeys: [...this.data.keys()],
      variables: Object.fromEntries(this.variables),
      recentPages: this.navigationHistory.slice(-10),
      recentActions: this.actionLog.slice(-10),
    };
  }

  getActionLog(limit = 50) {
    return this.actionLog.slice(-limit);
  }

  getNavigationHistory(limit = 50) {
    return this.navigationHistory.slice(-limit);
  }

  reset() {
    this.startedAt = Date.now();
    this.navigationHistory = [];
    this.actionLog = [];
    this.data.clear();
    this.variables.clear();
  }
}
