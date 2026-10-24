// Every night at 00:20 Brisbane: moves finished runs older than 30 days to monthly
// archive files in the data folder (data\archive\runs-YYYY-MM.json). Keeps runs.json small.
import { archiveOldRuns } from '../src/retention.js';

export default {
  id: 'retention',
  description: 'Archives runs older than 30 days to monthly files.',
  schedule: { dailyAt: '00:20' },
  steps: [
    {
      type: 'code',
      name: 'archive',
      fn: (ctx) => {
        const r = archiveOldRuns(ctx.store, { now: ctx.now(), maxAgeDays: ctx.input.maxAgeDays ?? 30 });
        return { archived: r.archived, months: r.files.length };
      },
    },
  ],
};
