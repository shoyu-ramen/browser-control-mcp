export class EventBus {
  constructor(maxSize = 1000, maxAgeMs = 300000) {
    this.events = [];
    this.maxSize = maxSize;
    this.maxAgeMs = maxAgeMs;
  }

  push(eventType, data) {
    this.events.push({ eventType, data, receivedAt: Date.now() });
    if (this.events.length > this.maxSize) {
      this.events = this.events.slice(-this.maxSize);
    }
  }

  get(filter = {}) {
    this._prune();
    let result = this.events;
    if (filter.type) result = result.filter(e => e.eventType === filter.type);
    if (filter.since) result = result.filter(e => e.receivedAt > filter.since);
    if (filter.limit) result = result.slice(-filter.limit);
    return result;
  }

  drain(filter = {}) {
    const events = this.get(filter);
    if (filter.type) {
      this.events = this.events.filter(e => e.eventType !== filter.type);
    } else {
      this.events = [];
    }
    return events;
  }

  clear(filter = {}) {
    if (filter.type) {
      this.events = this.events.filter(e => e.eventType !== filter.type);
    } else {
      this.events = [];
    }
  }

  _prune() {
    const cutoff = Date.now() - this.maxAgeMs;
    this.events = this.events.filter(e => e.receivedAt > cutoff);
  }

  get size() {
    return this.events.length;
  }
}
