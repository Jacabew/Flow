// Simple scheduler. Supported trigger forms on a flow:
//   { schedule: { everyMinutes: 15 } }
//   { schedule: { dailyAt: '07:30' } }              // Brisbane time (UTC+10, no daylight saving)
//   { schedule: { dailyAt: '07:30', days: [1,5] } } // 0=Sun ... 6=Sat, Brisbane time
const BRISBANE_OFFSET_MIN = 10 * 60;

export function brisbaneParts(date) {
  const b = new Date(date.getTime() + BRISBANE_OFFSET_MIN * 60_000);
  return { day: b.getUTCDay(), hhmm: `${pad(b.getUTCHours())}:${pad(b.getUTCMinutes())}`, minuteOfDay: b.getUTCHours() * 60 + b.getUTCMinutes() };
}

export function isDue(schedule, date, lastRunAt) {
  const p = brisbaneParts(date);
  if (schedule.everyMinutes) {
    if (!lastRunAt) return true;
    return date.getTime() - Date.parse(lastRunAt) >= schedule.everyMinutes * 60_000 - 1000;
  }
  if (schedule.dailyAt) {
    if (schedule.days && !schedule.days.includes(p.day)) return false;
    if (p.hhmm !== schedule.dailyAt) return false;
    // Don't double-fire within the same minute.
    return !lastRunAt || date.getTime() - Date.parse(lastRunAt) > 60_000;
  }
  return false;
}

export function startScheduler(engine, { tickMs = 30_000, now = () => new Date() } = {}) {
  const lastRun = new Map();
  const tick = async () => {
    const date = now();
    for (const flow of engine.flows.values()) {
      if (!flow.schedule || !engine.isEnabled(flow.id)) continue;
      if (isDue(flow.schedule, date, lastRun.get(flow.id))) {
        lastRun.set(flow.id, date.toISOString());
        engine.trigger(flow.id, { scheduledAt: date.toISOString() }, 'schedule').catch(() => {});
      }
    }
  };
  const handle = setInterval(tick, tickMs);
  tick();
  return () => clearInterval(handle);
}

const pad = (n) => String(n).padStart(2, '0');
