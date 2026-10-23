// Alerts (phone push via ntfy if set) when the heartbeat hasn't succeeded in 15 min.
// Alerts once per outage; logs when the heartbeat recovers.
import { checkHeartbeat, shouldAlert } from '../src/watchdog.js';

export default {
  id: 'watchdog',
  description: 'Alerts if the heartbeat has not succeeded in 15 minutes.',
  schedule: { everyMinutes: 5 },
  steps: [
    {
      type: 'code',
      name: 'check',
      fn: (ctx) => {
        const previous = ctx.store
          .list('runs', (r) => r.flowId === 'watchdog' && r.id !== ctx.runId && r.steps?.check)
          .at(-1)?.steps.check;
        const check = checkHeartbeat({ runs: ctx.store.list('runs'), now: ctx.now(), engineStartedAt: ctx.engineStartedAt });
        return { ...check, alert: shouldAlert(check, previous), recovered: Boolean(previous?.stale && !check.stale) };
      },
    },
    { type: 'if', name: 'needs-alert', when: (ctx) => ctx.steps.check.alert },
    {
      type: 'code',
      name: 'raise',
      fn: (ctx) => {
        const c = ctx.steps.check;
        throw new Error(c.lastSuccessAt
          ? `Heartbeat stale: last success ${c.ageMin} min ago (${c.lastSuccessAt})`
          : 'Heartbeat stale: no successful heartbeat recorded');
      },
    },
  ],
};
