// Tiny durable store. Zero dependencies on purpose (no native builds on Windows).
//
// Each collection is an append-only log: data\<name>.jsonl, one JSON line per change.
//   {"put":{...row}}   insert or update (the whole row)
//   {"del":"<id>"}     remove
// A change appends one short line instead of rewriting the whole file, so cost per
// write stays flat however many runs are kept. On load the log is replayed into memory.
// When the log holds far more lines than live rows it is compacted (rewritten to one
// put per live row, temp file + rename, so a crash mid-compaction loses nothing).
//
// A torn last line (power cut mid-append) is skipped. Older stores used one
// pretty-printed <name>.json per collection; it is imported once and renamed
// <name>.json.migrated.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Compact when the log has this many more lines than live rows (and at least 2x them).
const COMPACT_SLACK = 2000;

export class Store {
  constructor(dir, { compactSlack = COMPACT_SLACK } = {}) {
    this.dir = dir;
    this.compactSlack = compactSlack;
    fs.mkdirSync(dir, { recursive: true });
    this.cache = new Map(); // name -> rows (array, insertion order)
    this.lines = new Map(); // name -> lines currently in the log file
  }

  #file(name) {
    return path.join(this.dir, `${name}.jsonl`);
  }

  #legacy(name) {
    return path.join(this.dir, `${name}.json`);
  }

  load(name) {
    if (this.cache.has(name)) return this.cache.get(name);
    const f = this.#file(name);
    let rows;
    if (fs.existsSync(f)) {
      rows = this.#replay(name, f);
    } else {
      rows = this.#importLegacy(name);
    }
    this.cache.set(name, rows);
    return rows;
  }

  #replay(name, f) {
    const text = fs.readFileSync(f, 'utf8');
    const byId = new Map();
    let lines = 0;
    let bad = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let op;
      try {
        op = JSON.parse(line);
      } catch {
        bad++;
        continue;
      }
      lines++;
      if (op?.put?.id) {
        // Keep original position for updates; a re-put after delete goes to the end.
        byId.set(op.put.id, op.put);
      } else if (op?.del) {
        byId.delete(op.del);
      }
    }
    const rows = [...byId.values()];
    if (bad) {
      // Keep a copy for inspection, then rewrite clean so the bad lines don't linger.
      fs.copyFileSync(f, `${f}.corrupt-${Date.now()}`);
      this.cache.set(name, rows);
      this.#compact(name);
    } else {
      this.lines.set(name, lines);
    }
    return rows;
  }

  #importLegacy(name) {
    const old = this.#legacy(name);
    if (!fs.existsSync(old)) {
      this.lines.set(name, 0);
      return [];
    }
    let rows = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(old, 'utf8'));
      if (Array.isArray(parsed)) rows = parsed;
    } catch {
      // Corrupt file: keep a copy for inspection, start clean rather than crash the engine.
      fs.copyFileSync(old, `${old}.corrupt-${Date.now()}`);
    }
    this.cache.set(name, rows);
    this.#compact(name); // writes <name>.jsonl atomically
    fs.renameSync(old, `${old}.migrated`);
    return rows;
  }

  #append(name, op) {
    fs.appendFileSync(this.#file(name), JSON.stringify(op) + '\n');
    const lines = (this.lines.get(name) ?? 0) + 1;
    this.lines.set(name, lines);
    const live = this.load(name).length;
    if (lines - live > this.compactSlack && lines > live * 2) this.#compact(name);
  }

  #compact(name) {
    const f = this.#file(name);
    const tmp = `${f}.tmp`;
    const rows = this.cache.get(name) ?? [];
    fs.writeFileSync(tmp, rows.map((r) => JSON.stringify({ put: r }) + '\n').join(''));
    fs.renameSync(tmp, f);
    this.lines.set(name, rows.length);
  }

  // Rewrite the log as one line per live row. Called automatically; exposed for tests/tools.
  compact(name) {
    this.load(name);
    this.#compact(name);
  }

  insert(name, record) {
    const rows = this.load(name);
    const row = { id: crypto.randomUUID(), ...record };
    rows.push(row);
    this.#append(name, { put: row });
    return row;
  }

  update(name, id, patch) {
    const row = this.load(name).find((r) => r.id === id);
    if (!row) return null;
    Object.assign(row, patch);
    this.#append(name, { put: row });
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
    for (const r of removed) this.#append(name, { del: r.id });
    return removed;
  }

  // Safety cap: drop oldest rows beyond `max`.
  trim(name, max) {
    const rows = this.load(name);
    if (rows.length > max) {
      const dropped = rows.splice(0, rows.length - max);
      for (const r of dropped) this.#append(name, { del: r.id });
    }
  }

  // Bytes on disk for a collection's log (for status/diagnostics).
  sizeBytes(name) {
    try {
      return fs.statSync(this.#file(name)).size;
    } catch {
      return 0;
    }
  }
}
