// Heartbeat watchdog logic. Pure functions so they are easy to test.
// "Stale" = no successful heartbeat run in the last `maxAgeMin` minutes.
// A fresh start gets the same grace period, so a restart never false-alarms.
export function checkHeartbeat({ runs, now, engineStartedAt, flowId = 'heartbeat', maxAgeMin = 15 }) {
  const nowMs = now.getTime();
  const maxMs = maxAgeMin * 60_000;
  const last = runs
    .filter((r) => r.flowId === flowId && r.status === 'success')
    .map((r) => Date.parse(r.finishedAt ?? r.startedAt))
    .reduce((a, b) => Math.max(a, b), -Infinity);
  const lastSuccessAt = Number.isFinite(last) ? new Date(last).toISOString() : null;
  const ageMin = Number.isFinite(last) ? Math.round((nowMs - last) / 60_000) : null;
  const inGrace = nowMs - Date.parse(engineStartedAt) < maxMs;
  const stale = !inGrace && (!Number.isFinite(last) || nowMs - last > maxMs);
  return { stale, lastSuccessAt, ageMin };
}

// Alert once per outage, not every 5 minutes: only when the previous watchdog check was fine.
export function shouldAlert(check, previousCheck) {
  return check.stale && !previousCheck?.stale;
}
