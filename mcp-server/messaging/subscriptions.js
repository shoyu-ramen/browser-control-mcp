export class SubscriptionManager {
  constructor() {
    this.subscriptions = new Map();
    this.nextId = 1;
    this.sendToExtension = null;
  }

  setSender(fn) {
    this.sendToExtension = fn;
  }

  subscribe(eventType, filter = {}) {
    const id = `sub_${this.nextId++}`;
    const sub = { id, eventType, filter, createdAt: Date.now() };
    this.subscriptions.set(id, sub);
    this.sendToExtension?.({ type: "subscribe", subscriptionId: id, eventType, filter });
    return sub;
  }

  unsubscribe(id) {
    const sub = this.subscriptions.get(id);
    if (!sub) return false;
    this.subscriptions.delete(id);
    const stillNeeded = [...this.subscriptions.values()].some(s => s.eventType === sub.eventType);
    if (!stillNeeded) {
      this.sendToExtension?.({ type: "unsubscribe", subscriptionId: id, eventType: sub.eventType });
    }
    return true;
  }

  list() {
    return [...this.subscriptions.values()];
  }

  has(eventType) {
    return [...this.subscriptions.values()].some(s => s.eventType === eventType);
  }

  clear() {
    const types = new Set([...this.subscriptions.values()].map(s => s.eventType));
    for (const type of types) {
      this.sendToExtension?.({ type: "unsubscribe", subscriptionId: "all", eventType: type });
    }
    this.subscriptions.clear();
  }
}
