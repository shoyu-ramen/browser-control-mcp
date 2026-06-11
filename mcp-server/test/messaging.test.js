// Unit tests for the messaging layer — EventBus, SubscriptionManager,
// SessionState. These are pure, in-memory modules with no I/O, so they import
// directly (no loader/stub needed) and run in microseconds.
//
// Run via:  npm test

import { test } from "node:test";
import assert from "node:assert/strict";

import { EventBus } from "../messaging/event-bus.js";
import { SubscriptionManager } from "../messaging/subscriptions.js";
import { SessionState } from "../messaging/session-state.js";

// ---------------------------------------------------------------------------
// EventBus
// ---------------------------------------------------------------------------

test("EventBus: push + size + get returns stored events in order", () => {
  const bus = new EventBus();
  assert.equal(bus.size, 0);
  bus.push("navigation", { url: "https://a.test" });
  bus.push("console", { text: "hello" });
  assert.equal(bus.size, 2);

  const all = bus.get();
  assert.equal(all.length, 2);
  assert.equal(all[0].eventType, "navigation");
  assert.equal(all[0].data.url, "https://a.test");
  assert.equal(typeof all[0].receivedAt, "number");
});

test("EventBus: get filters by type", () => {
  const bus = new EventBus();
  bus.push("navigation", { n: 1 });
  bus.push("console", { n: 2 });
  bus.push("navigation", { n: 3 });

  const nav = bus.get({ type: "navigation" });
  assert.equal(nav.length, 2);
  assert.deepEqual(nav.map((e) => e.data.n), [1, 3]);
});

test("EventBus: get filters by since (timestamp) and limit", () => {
  const bus = new EventBus();
  bus.push("e", { n: 1 });
  const cutoff = bus.get()[0].receivedAt; // first event's timestamp
  // Force a strictly-greater timestamp so the `since` (exclusive) filter is
  // deterministic even when Date.now() has coarse resolution.
  bus.events.push({ eventType: "e", data: { n: 2 }, receivedAt: cutoff + 5 });
  bus.events.push({ eventType: "e", data: { n: 3 }, receivedAt: cutoff + 6 });

  const recent = bus.get({ since: cutoff });
  assert.deepEqual(recent.map((e) => e.data.n), [2, 3]);

  const limited = bus.get({ limit: 1 });
  assert.deepEqual(limited.map((e) => e.data.n), [3]); // last N
});

test("EventBus: enforces maxSize ring-buffer cap", () => {
  const bus = new EventBus(3);
  for (let i = 0; i < 6; i++) bus.push("e", { i });
  assert.equal(bus.size, 3);
  // Keeps the most recent 3.
  assert.deepEqual(bus.get().map((e) => e.data.i), [3, 4, 5]);
});

test("EventBus: _prune drops events older than maxAgeMs on get()", () => {
  const bus = new EventBus(1000, 100); // 100ms max age
  bus.events.push({ eventType: "old", data: {}, receivedAt: Date.now() - 1000 });
  bus.push("fresh", {});
  const result = bus.get();
  assert.equal(result.length, 1);
  assert.equal(result[0].eventType, "fresh");
});

test("EventBus: drain returns matching events and removes them", () => {
  const bus = new EventBus();
  bus.push("a", { n: 1 });
  bus.push("b", { n: 2 });
  bus.push("a", { n: 3 });

  const drained = bus.drain({ type: "a" });
  assert.deepEqual(drained.map((e) => e.data.n), [1, 3]);
  // Only the non-'a' event remains.
  assert.deepEqual(bus.get().map((e) => e.eventType), ["b"]);

  const rest = bus.drain();
  assert.equal(rest.length, 1);
  assert.equal(bus.size, 0);
});

test("EventBus: clear by type and clear all", () => {
  const bus = new EventBus();
  bus.push("a", {});
  bus.push("b", {});
  bus.clear({ type: "a" });
  assert.deepEqual(bus.get().map((e) => e.eventType), ["b"]);
  bus.clear();
  assert.equal(bus.size, 0);
});

// ---------------------------------------------------------------------------
// SubscriptionManager
// ---------------------------------------------------------------------------

test("SubscriptionManager: subscribe assigns id, stores sub, notifies sender", () => {
  const mgr = new SubscriptionManager();
  const sent = [];
  mgr.setSender((m) => sent.push(m));

  const sub = mgr.subscribe("navigation", { urlPattern: "x" });
  assert.match(sub.id, /^sub_\d+$/);
  assert.equal(sub.eventType, "navigation");
  assert.deepEqual(sub.filter, { urlPattern: "x" });

  assert.equal(mgr.list().length, 1);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    type: "subscribe",
    subscriptionId: sub.id,
    eventType: "navigation",
    filter: { urlPattern: "x" },
  });
});

test("SubscriptionManager: ids are unique and monotonic", () => {
  const mgr = new SubscriptionManager();
  const a = mgr.subscribe("e");
  const b = mgr.subscribe("e");
  assert.notEqual(a.id, b.id);
});

test("SubscriptionManager: unsubscribe sends unsubscribe only when last of its type", () => {
  const mgr = new SubscriptionManager();
  const sent = [];
  mgr.setSender((m) => sent.push(m));

  const a = mgr.subscribe("navigation");
  const b = mgr.subscribe("navigation");
  sent.length = 0; // ignore the two subscribe sends

  // Removing one of two navigation subs: still needed, so NO unsubscribe sent.
  assert.equal(mgr.unsubscribe(a.id), true);
  assert.equal(sent.length, 0);
  assert.equal(mgr.has("navigation"), true);

  // Removing the last navigation sub: unsubscribe IS sent.
  assert.equal(mgr.unsubscribe(b.id), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "unsubscribe");
  assert.equal(sent[0].eventType, "navigation");
  assert.equal(mgr.has("navigation"), false);
});

test("SubscriptionManager: unsubscribe of unknown id returns false, no send", () => {
  const mgr = new SubscriptionManager();
  const sent = [];
  mgr.setSender((m) => sent.push(m));
  assert.equal(mgr.unsubscribe("sub_999"), false);
  assert.equal(sent.length, 0);
});

test("SubscriptionManager: clear sends one unsubscribe per distinct type and empties", () => {
  const mgr = new SubscriptionManager();
  const sent = [];
  mgr.setSender((m) => sent.push(m));
  mgr.subscribe("navigation");
  mgr.subscribe("navigation");
  mgr.subscribe("console");
  sent.length = 0;

  mgr.clear();
  assert.equal(mgr.list().length, 0);
  const types = sent.filter((m) => m.type === "unsubscribe").map((m) => m.eventType).sort();
  assert.deepEqual(types, ["console", "navigation"]); // one per distinct type
});

test("SubscriptionManager: works without a sender set (no throw)", () => {
  const mgr = new SubscriptionManager();
  assert.doesNotThrow(() => {
    const s = mgr.subscribe("e");
    mgr.unsubscribe(s.id);
    mgr.clear();
  });
});

// ---------------------------------------------------------------------------
// SessionState
// ---------------------------------------------------------------------------

test("SessionState: records navigation and exposes history", () => {
  const s = new SessionState();
  s.recordNavigation("https://a.test", "A");
  s.recordNavigation("https://b.test", "B");
  const hist = s.getNavigationHistory();
  assert.equal(hist.length, 2);
  assert.equal(hist[1].url, "https://b.test");
  assert.equal(hist[1].title, "B");
  assert.equal(typeof hist[1].timestamp, "number");
});

test("SessionState: navigation history caps at 200 (keeps most recent)", () => {
  const s = new SessionState();
  for (let i = 0; i < 250; i++) s.recordNavigation(`https://x/${i}`, String(i));
  assert.equal(s.navigationHistory.length, 200);
  assert.equal(s.navigationHistory.at(-1).url, "https://x/249");
  assert.equal(s.navigationHistory[0].url, "https://x/50");
});

test("SessionState: records actions, caps at 500, getActionLog respects limit", () => {
  const s = new SessionState();
  for (let i = 0; i < 600; i++) s.recordAction({ type: "command", command: `c${i}` });
  assert.equal(s.actionLog.length, 500);
  assert.equal(s.getActionLog(3).length, 3);
  assert.equal(s.getActionLog(3).at(-1).command, "c599");
});

test("SessionState: data store get/getAll", () => {
  const s = new SessionState();
  assert.equal(s.getData("missing"), undefined);
  s.storeData("k", { hello: "world" });
  assert.deepEqual(s.getData("k"), { hello: "world" });
  const all = s.getAllData();
  assert.ok("k" in all);
  assert.deepEqual(all.k.value, { hello: "world" });
  assert.equal(typeof all.k.storedAt, "number");
});

test("SessionState: variables set/get", () => {
  const s = new SessionState();
  assert.equal(s.getVariable("v"), undefined);
  s.setVariable("v", 42);
  assert.equal(s.getVariable("v"), 42);
});

test("SessionState: getContext summarizes session", () => {
  const s = new SessionState();
  s.recordNavigation("https://a.test", "A");
  s.recordAction({ type: "command", command: "navigate" });
  s.storeData("k", 1);
  s.setVariable("v", "val");

  const ctx = s.getContext();
  assert.equal(ctx.pagesVisited, 1);
  assert.equal(ctx.actionsPerformed, 1);
  assert.deepEqual(ctx.dataKeys, ["k"]);
  assert.deepEqual(ctx.variables, { v: "val" });
  assert.equal(ctx.recentPages.length, 1);
  assert.equal(ctx.recentActions.length, 1);
  assert.ok(ctx.sessionDurationMs >= 0);
  assert.equal(typeof ctx.startedAt, "string"); // ISO string
});

test("SessionState: reset clears everything", () => {
  const s = new SessionState();
  s.recordNavigation("https://a.test", "A");
  s.recordAction({ type: "command", command: "x" });
  s.storeData("k", 1);
  s.setVariable("v", 2);

  s.reset();
  assert.equal(s.navigationHistory.length, 0);
  assert.equal(s.actionLog.length, 0);
  assert.deepEqual(s.getAllData(), {});
  assert.equal(s.getVariable("v"), undefined);
});
