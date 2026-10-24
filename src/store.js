// Tiny durable JSON store. Zero dependencies on purpose (no native builds on Windows).
// Each collection is one JSON file, written atomically (write temp file, then rename).
// Fine for the volumes DS Flow handles (hundreds of runs/day). Swap for SQLite later
// behind this same interface if volume ever demands it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.cache = new Map();
  }

  #file(name) {
    return path.join(this.dir, `${name}.json`);
  }

  load(name) {
    if (this.cache.has(name)) return this.cache.get(name);
    let data = [];
    const f = this.#file(name);
    if (fs.existsSync(f)) {
      try {
        data = JSON.parse(fs.readFileSync(f, 'utf8'));
      } catch (err) {
        // Corrupt file: keep a copy for inspection, start clean rather than crash the engine.
        fs.copyFileSync(f, `${f}.corrupt-${Date.now()}`);
        data = [];
      }
    }
    this.cache.set(name, data);
    return data;
  }

  save(name) {
    const f = this.#file(name);
    const tmp = `${f}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.load(name), null, 2));
    fs.renameSync(tmp, f);
  }

  insert(name, record) {
    const rows = this.load(name);
    const row = { id: crypto.randomUUID(), ...record };
    rows.push(row);
    this.save(name);
    return row;
  }

  update(name, id, patch) {
    const row = this.load(name).find((r) => r.id === id);
    if (!row) return null;
    Object.assign(row, patch);
    this.save(name);
    return row;
  }

  get(name, id) {
    return this.load(name).find((r) => r.id === id) ?? null;
  }

  list(name, filter = () => true) {
    return this.load(name).filter(filter);
  }

  // Remove rows matching `filter`; returns the removed rows.
  remove(name, filter) {
    const rows = this.load(name);
    const removed = [];
    for (let i = rows.length - 1; i >= 0; i--) {
      if (filter(rows[i])) removed.unshift(...rows.splice(i, 1));
    }
    if (removed.length) this.save(name);
    return removed;
  }

  // Keep files small: drop oldest rows beyond `max`.
  trim(name, max) {
    const rows = this.load(name);
    if (rows.length > max) {
      rows.splice(0, rows.length - max);
      this.save(name);
    }
  }
}
