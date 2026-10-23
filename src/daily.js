// Daily summary: yesterday's runs and failures (Brisbane day), as a small JSON status file.
import fs from 'node:fs';
import path from 'node:path';

const BRISBANE_OFFSET_MS = 10 * 3600_000;

// Brisbane calendar date (YYYY-MM-DD) of `date`, shifted by `deltaDays`.
export function brisbaneDate(date, deltaDays = 0) {
  return new Date(date.getTime() + BRISBANE_OFFSET_MS + deltaDays * 86_400_000).toISOString().slice(0, 10);
}

export function summariseDay({ runs, alerts = [], day }) {
  const start = Date.parse(`${day}T00:00:00Z`) - BRISBANE_OFFSET_MS;
  const end = start + 86_400_000;
  const inDay = (iso) => { const t = Date.parse(iso); return t >= start && t < end; };
  const dayRuns = runs.filter((r) => inDay(r.startedAt));
  const byFlow = {};
  for (const r of dayRuns) {
    const f = (byFlow[r.flowId] ??= { runs: 0, success: 0, failed: 0, other: 0 });
    f.runs++;
    if (r.status === 'success') f.success++;
    else if (r.status === 'failed') f.failed++;
    else f.other++;
  }
  const failures = dayRuns
    .filter((r) => r.status === 'failed')
    .map((r) => ({ flowId: r.flowId, runId: r.id, at: r.startedAt, error: r.error }));
  return {
    day,
    ok: failures.length === 0,
    runs: dayRuns.length,
    failed: failures.length,
    alerts: alerts.filter((a) => inDay(a.at)).length,
    byFlow,
    failures: failures.slice(-50),
  };
}

// Atomic write so OneDrive never syncs a half-written file.
export function writeStatusFile(dir, name, data) {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(data, null, 2));
  fs.renameSync(`${f}.tmp`, f);
  return f;
}
