// Every night at 00:10 Brisbane: writes yesterday's runs/failures to FLOW_STATUS_DIR/daily.json
// (OneDrive\FLOW\status on the HUB) so a Claude session can see HUB health remotely.
import { brisbaneDate, summariseDay, writeStatusFile } from '../src/daily.js';

export default {
  id: 'daily-summary',
  description: "Writes yesterday's runs and failures to OneDrive\\FLOW\\status\\daily.json.",
  schedule: { dailyAt: '00:10' },
  steps: [
    {
      type: 'code',
      name: 'summary',
      fn: (ctx) => summariseDay({
        runs: ctx.store.list('runs'),
        alerts: ctx.store.list('alerts'),
        day: ctx.input.day ?? brisbaneDate(ctx.now(), -1),
      }),
    },
    {
      type: 'code',
      name: 'write',
      fn: (ctx) => {
        const dir = ctx.input.statusDir ?? process.env.FLOW_STATUS_DIR;
        if (!dir) return { written: false, reason: 'FLOW_STATUS_DIR not set' };
        const summary = { ...ctx.steps.summary, generatedAt: ctx.now().toISOString() };
        return { written: true, file: writeStatusFile(dir, 'daily.json', summary) };
      },
    },
  ],
};
