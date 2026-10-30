// SHADOW WEEK for the daily Xero back-feed. Every morning at 08:30 Brisbane:
//   1. reads DSOS's own back-feed status (read-only),
//   2. logs the sync request DS Flow WOULD send to DSOS (shadow: never sent; this flow has no
//      `live` flag, so even FLOW_DSOS_WRITES=live can't make it real),
//   3. records whether DSOS's own morning sync ran OK today, and the 7-day match count.
// DS Flow never talks to Xero directly: Xero credentials stay in DSOS.
// Until the DSOS token exists (DSOS_REQUESTS #3) the run stops quietly at step 1, no alert.
// Report: GET /api/shadow/xero-backfeed
import { parseSyncStatus, compareDay, recordDay, backfeedReport } from '../src/backfeed.js';

export const STATUS_PATH = process.env.FLOW_XERO_STATUS_PATH || '/api/v1/xero/sync-status';
export const SYNC_PATH = '/api/v1/xero/sync';

export default {
  id: 'xero-backfeed-shadow',
  description: 'Shadow: checks DSOS ran its Xero back-feed today and logs the sync DS Flow would trigger.',
  schedule: { dailyAt: '08:30' },
  steps: [
    {
      type: 'if',
      name: 'dsos-configured',
      when: (ctx) => Boolean(ctx.connectors?.dsos?.config().configured),
    },
    { type: 'dsos', name: 'status', path: STATUS_PATH },
    { type: 'dsos', name: 'would-sync', method: 'POST', path: SYNC_PATH, body: { source: 'ds-flow', mode: 'daily' } },
    {
      type: 'code',
      name: 'compare',
      fn: (ctx) => {
        if (!ctx.steps['would-sync']?.shadow) throw new Error('back-feed sync was not shadowed; refusing to continue');
        const entry = compareDay({ now: ctx.now(), status: parseSyncStatus(ctx.steps.status.body) });
        recordDay(ctx.store, { ...entry, runId: ctx.runId });
        return entry;
      },
    },
    {
      type: 'code',
      name: 'week',
      fn: (ctx) => {
        const { recent, ...report } = backfeedReport(ctx.store, ctx.now());
        return report;
      },
    },
  ],
};
