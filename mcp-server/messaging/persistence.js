import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";

export class Persistence {
  constructor() {
    this._timers = new Map();
  }

  loadJSON(filePath) {
    try {
      return JSON.parse(readFileSync(filePath, "utf-8"));
    } catch {
      return null;
    }
  }

  saveJSON(filePath, data) {
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = filePath + ".tmp";
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, filePath);
  }

  saveJSONDebounced(filePath, data, delayMs = 500) {
    if (this._timers.has(filePath)) {
      clearTimeout(this._timers.get(filePath));
    }
    this._timers.set(filePath, setTimeout(() => {
      this._timers.delete(filePath);
      this.saveJSON(filePath, data);
    }, delayMs));
  }

  flush() {
    for (const [filePath, timer] of this._timers) {
      clearTimeout(timer);
      this._timers.delete(filePath);
    }
  }
}
