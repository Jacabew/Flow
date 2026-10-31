// SHADOW RUN for recurring invoices (workshop rent etc.). Every evening at 21:15 Brisbane:
//   1. reads DSOS's recurring schedules (read-only),
//   2. checks YESTERDAY: did DSOS generate exactly the invoices predicted for it, at the
//      predicted amounts, and nothing unexpected?
//   3. records which schedules DSOS says run TOMORROW, and the amounts,
//   4. if any are due, logs the "generate due invoices" call DS Flow WOULD send tomorrow
//      morning (shadow: never sent; no `live` flag, so even FLOW_DSOS_WRITES=live can't send it).
// DS Flow never creates invoices or talks to Xero: DSOS keeps the invoice logic and credentials.
// Until the DSOS token exists (DSOS_REQUESTS #3) the run stops quietly at step 1, no alert.
// Report: GET /api/shadow/recurring-invoices
import { brisbaneDate } from '../src/daily.js';
import { parseSchedules, predictDay, savePrediction, saveVerification } from '../src/recurring.js';

export const SCHEDULES_PATH = process.env.FLOW_RECURRING_PATH || '/api/v1/recurring-invoices';
export const GENERATE_PATH = '/api/v1/recurring-invoices/generate-due';

export default {
  id: 'recurring-invoices-shadow',
  description: 'Shadow: predicts tomorrow\'s recurring invoices from DSOS, checks yesterday\'s were generated as predicted.',
  schedule: { dailyAt: '21:15' },
  steps: [
    {
      type: 'if',
      name: 'dsos-configured',
      when: (ctx) => Boolean(ctx.connectors?.dsos?.config().configured),
    },
    { type: 'dsos', name: 'schedules', path: SCHEDULES_PATH },
    {
      type: 'code',
      name: 'check',
      fn: (ctx) => {
        const now = ctx.now();
        const schedules = parseSchedules(ctx.steps.schedules.body);
        const yesterday = saveVerification(ctx.store, { day: brisbaneDate(now, -1), schedules, now, runId: ctx.runId });
        const day = brisbaneDate(now, 1);
        const predicted = predictDay(schedules, day);
        savePrediction(ctx.store, { day, predicted, now, runId: ctx.runId });
        return {
          schedules: schedules.length,
          yesterday: { day: yesterday.day, verdict: yesterday.verdict, items: yesterday.items },
          tomorrow: { day, predicted },
        };
      },
    },
    { type: 'if', name: 'anything-due', when: (ctx) => ctx.steps.check.tomorrow.predicted.length > 0 },
    {
      type: 'dsos',
      name: 'would-generate',
      method: 'POST',
      path: GENERATE_PATH,
      body: (ctx) => ({
        source: 'ds-flow',
        day: ctx.steps.check.tomorrow.day,
        scheduleIds: ctx.steps.check.tomorrow.predicted.map((p) => p.scheduleId),
      }),
    },
    {
      type: 'code',
      name: 'confirm-shadow',
      fn: (ctx) => {
        if (!ctx.steps['would-generate']?.shadow) throw new Error('recurring invoice call was not shadowed; refusing to continue');
        return { shadowed: true };
      },
    },
  ],
};
