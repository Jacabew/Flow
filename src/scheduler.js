// Simple scheduler. Supported trigger forms on a flow:
//   { schedule: { everyMinutes: 15 } }
//   { schedule: { dailyAt: '07:30' } }              // Brisbane time (UTC+10, no daylight saving)
//   { schedule: { dailyAt: '07:30', days: [1,5] } } // 0=Sun ... 6=Sat, Brisbane time
//   { schedule: { dailyAt: '07:30', days: ['Mon','Fri'] } } // day names work too
//   { schedule: { weekly: 'Mon,Wed 07:30' } }       // shorthand for the line above
// Schedules are checked when a flow is registered, so a typo fails loudly instead of never firing.
//
// Catch-up: the last scheduled run of every daily/weekly flow is kept in the store
// (collection schedule_state). If the HUB was off or restarting at a flow's slot, the flow
// runs once as soon as DS Flow is back, as long as it is still the same Brisbane day.
// Input then carries catchUp: true. A flow with no record of ever running is not caught up.
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

// Today's (Brisbane) slot for a daily/weekly schedule as a Date, or null if it has none today.
export function slotToday(rawSchedule, date) {
  const schedule = normalizeSchedule(rawSchedule);
  if (!schedule.dailyAt) return null;
  const p = brisbaneParts(date);
  if (schedule.days && !schedule.days.includes(p.day)) return null;
  const [h, m] = schedule.dailyAt.split(':').map(Number);
  const midnight = date.getTime() - (p.minuteOfDay * 60_000 + (date.getTime() % 60_000));
  return new Date(midnight + (h * 60 + m) * 60_000);
}

// The slot a daily/weekly flow missed today, or null. Needs a known last run: without one we
// can't tell "missed" from "never ran", and a brand-new flow shouldn't fire on deploy.
export function missedSlot(rawSchedule, date, lastRunAt) {
  if (!lastRunAt) return null;
  const slot = slotToday(rawSchedule, date);
  if (!slot) return null;
  if (date.getTime() < slot.getTime() + 60_000) return null; // not passed yet, or isDue's minute
  if (Date.parse(lastRunAt) >= slot.getTime()) return null; // already ran (or caught up) today
  return slot;
}

const STATE = 'schedule_state';

function loadLastRuns(store, flows) {
  const out = new Map();
  for (const flow of flows) {
    const saved = store.get(STATE, `sched:${flow.id}`)?.lastRunAt;
    // First start with this feature: fall back to the run log.
    const fromRuns = saved ? null : store.list('runs', (r) => r.flowId === flow.id && r.source === 'schedule').at(-1)?.startedAt;
    const last = saved ?? fromRuns;
    if (last) out.set(flow.id, last);
  }
  return out;
}

function saveLastRun(store, flowId, at) {
  try {
    const id = `sched:${flowId}`;
    if (store.get(STATE, id)) store.update(STATE, id, { lastRunAt: at });
    else store.insert(STATE, { id, flowId, lastRunAt: at });
  } catch (err) {
    console.error(`Scheduler: could not save last run for ${flowId}: ${err.message}`);
  }
}

export function startScheduler(engine, { tickMs = 30_000, now = () => new Date() } = {}) {
  const daily = [...engine.flows.values()].filter((f) => f.schedule && normalizeSchedule(f.schedule).dailyAt);
  const lastRun = engine.store ? loadLastRuns(engine.store, daily) : new Map();
  const isDaily = new Set(daily.map((f) => f.id));
  const tick = async () => {
    const date = now();
    for (const flow of engine.flows.values()) {
      if (!flow.schedule || !engine.isEnabled(flow.id)) continue;
      const last = lastRun.get(flow.id);
      let input = null;
      if (isDue(flow.schedule, date, last)) {
        input = { scheduledAt: date.toISOString() };
      } else if (isDaily.has(flow.id)) {
        const missed = missedSlot(flow.schedule, date, last);
        if (missed) input = { scheduledAt: missed.toISOString(), catchUp: true };
      }
      if (!input) continue;
      lastRun.set(flow.id, date.toISOString());
      if (isDaily.has(flow.id) && engine.store) saveLastRun(engine.store, flow.id, date.toISOString());
      if (input.catchUp) console.log(`Scheduler: catching up ${flow.id} (missed ${input.scheduledAt})`);
      engine.trigger(flow.id, input, 'schedule').catch(() => {});
    }
  };
  const handle = setInterval(tick, tickMs);
  tick();
  return () => clearInterval(handle);
}

const pad = (n) => String(n).padStart(2, '0');
