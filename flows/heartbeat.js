// Proves the engine and scheduler are alive. The deploy script and Mission Control
// can check that a heartbeat run succeeded in the last 15 minutes.
export default {
  id: 'heartbeat',
  description: 'Writes a run every 5 minutes so we know DS Flow is alive.',
  schedule: { everyMinutes: 5 },
  steps: [{ type: 'log', name: 'beat', message: () => `alive at ${new Date().toISOString()}` }],
};
