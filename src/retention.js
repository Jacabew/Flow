// Run retention: move finished runs older than `maxAgeDays` out of the live store into
// monthly archive files (<dataDir>/archive/runs-YYYY-MM.json, Brisbane month of startedAt).
// Archive is written first, then rows are removed, so a crash can duplicate but never lose a run.
// Runs still "running" or "waiting_approval" are never archived.
import fs from 'node:fs';
import path from 'node:path';

const BRISBANE_OFFSET_MS = 10 * 3600_000;
const LIVE = new Set(['running', 'waiting_approval']);

export const brisbaneMonth = (iso) => new Date(Date.parse(iso) + BRISBANE_OFFSET_MS).toISOString().slice(0, 7);

export function archiveOldRuns(store, { now = new Date(), maxAgeDays = 30, archiveDir = path.join(store.dir, 'archive') } = {}) {
  const cutoff = now.getTime() - maxAgeDays * 86_400_000;
  const isOld = (r) => !LIVE.has(r.status) && Date.parse(r.startedAt) < cutoff;
  const old = store.list('runs', isOld);
  if (!old.length) return { archived: 0, files: [] };

  const byMonth = new Map();
  for (const r of old) {
    const m = brisbaneMonth(r.startedAt);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(r);
  }

  fs.mkdirSync(archiveDir, { recursive: true });
  const files = [];
  for (const [month, rows] of byMonth) {
    const f = path.join(archiveDir, `runs-${month}.json`);
    let existing = [];
    if (fs.existsSync(f)) {
      try { existing = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {
        fs.copyFileSync(f, `${f}.corrupt-${Date.now()}`);
      }
    }
    const seen = new Set(existing.map((r) => r.id));
    const merged = existing.concat(rows.filter((r) => !seen.has(r.id)))
      .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(merged));
    fs.renameSync(`${f}.tmp`, f);
    files.push(f);
  }

  const ids = new Set(old.map((r) => r.id));
  store.remove('runs', (r) => ids.has(r.id));
  return { archived: old.length, files };
}
