// Simple scheduler. Supported trigger forms on a flow:
//   { schedule: { everyMinutes: 15 } }
//   { schedule: { dailyAt: '07:30' } }              // Brisbane time (UTC+10, no daylight saving)
//   { schedule: { dailyAt: '07:30', days: [1,5] } } // 0=Sun ... 6=Sat, Brisbane time
//   { schedule: { dailyAt: '07:30', days: ['Mon','Fri'] } } // day names work too
//   { schedule: { weekly: 'Mon,Wed 07:30' } }       // shorthand for the line above
// Schedules are checked when a flow is registered, so a typo fails loudly instead of never firing.
const BRISBANE_OFFSET_MIN = 10 * 60;

export function brisbaneParts(date) {
  const b = new Date(date.getTime() + BRISBANE_OFFSET_MIN * 60_000);
  return { day: b.getUTCDay(), hhmm: `${pad(b.getUTCHours())}:${pad(b.getUTCMinutes())}`, minuteOfDay: b.getUTCHours() * 60 + b.getUTCMinutes() };
}

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function toDay(d) {
  if (Number.isInteger(d) && d >= 0 && d <= 6) return d;
  const i = typeof d === 'string' ? DAY_NAMES.indexOf(d.trim().slice(0, 3).toLowerCase()) : -1;
  if (i === -1) throw new Error(`Schedule: unknown day "${d}" (use Mon..Sun or 0..6)`);
  return i;
}

// Returns { everyMinutes } or { dailyAt, days? } with days as numbers. Throws on anything invalid.
export function normalizeSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object') throw new Error('Schedule must be an object');
  if (schedule.everyMinutes != null) {
    if (!(schedule.everyMinutes > 0)) throw new Error('Schedule: everyMinutes must be > 0');
    return { everyMinutes: schedule.everyMinutes };
  }
  let { dailyAt, days } = schedule;
  if (schedule.weekly != null) {
    const m = /^\s*([A-Za-z,\s]+?)\s+(\d{1,2}:\d{2})\s*$/.exec(String(schedule.weekly));
    if (!m) throw new Error(`Schedule: weekly "${schedule.weekly}" should look like "Mon,Wed 07:30"`);
    days = m[1].split(',').filter((d) => d.trim());
    dailyAt = m[2];
  }
  const t = /^(\d{1,2}):(\d{2})$/.exec(String(dailyAt ?? ''));
  if (!t || Number(t[1]) > 23 || Number(t[2]) > 59) throw new Error(`Schedule: time "${dailyAt}" should be HH:MM (24h)`);
  const out = { dailyAt: `${pad(Number(t[1]))}:${t[2]}` };
  if (days != null) {
    if (!Array.isArray(days) || days.length === 0) throw new Error('Schedule: days must be a non-empty list');
    out.days = [...new Set(days.map(toDay))];
  }
  return out;
}

export function isDue(rawSchedule, date, lastRunAt) {
  const schedule = normalizeSchedule(rawSchedule);
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
