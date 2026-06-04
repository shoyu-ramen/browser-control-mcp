import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.js";

// Append-only JSONL event log + a small JSON file for store-side install stats.
// Phase 0 keeps this dependency-free and file-backed. Swap the read/append/write
// internals for Postgres or a Railway volume before high-volume production.

const eventsFile = () => path.join(config.dataDir, "events.jsonl");
const storeStatsFile = () => path.join(config.dataDir, "store-stats.json");

let events = [];
const seen = new Set();      // dedupe keys (LemonSqueezy can resend webhooks)
let writeChain = Promise.resolve();

export async function init() {
  await fsp.mkdir(config.dataDir, { recursive: true });
  events = [];
  seen.clear();
  try {
    const raw = await fsp.readFile(eventsFile(), "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const evt = JSON.parse(line);
      events.push(evt);
      if (evt.dedupe_key) seen.add(evt.dedupe_key);
    }
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
}

export function allEvents() {
  return events.slice();
}

export function seenDedupe(key) {
  return key ? seen.has(key) : false;
}

export async function appendEvent(evt) {
  const record = {
    id: evt.id || crypto.randomUUID(),
    recorded_at: new Date().toISOString(),
    ...evt,
  };
  events.push(record);
  if (record.dedupe_key) seen.add(record.dedupe_key);
  // Serialize appends so concurrent webhooks can't interleave a JSONL line.
  writeChain = writeChain.then(() =>
    fsp.appendFile(eventsFile(), JSON.stringify(record) + "\n")
  );
  await writeChain;
  return record;
}

export async function getStoreStats() {
  try {
    return JSON.parse(await fsp.readFile(storeStatsFile(), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return { installs: null, weekly_active: null, updated_at: null };
    throw e;
  }
}

export async function setStoreStats(stats) {
  const merged = {
    ...(await getStoreStats()),
    ...(stats.installs != null ? { installs: Number(stats.installs) } : {}),
    ...(stats.weekly_active != null ? { weekly_active: Number(stats.weekly_active) } : {}),
    updated_at: new Date().toISOString(),
  };
  await fsp.writeFile(storeStatsFile(), JSON.stringify(merged, null, 2));
  return merged;
}
