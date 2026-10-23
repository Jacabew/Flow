// Failure alerts. Always recorded in the store. Optionally pushed to Jake's phone.
// FLOW_ALERT_NTFY_TOPIC: push via ntfy.sh (free, no account, install the ntfy app and
// subscribe to the same private topic name). Leave unset to only record alerts.
export function makeAlerter(store, env = process.env) {
  return async ({ flowId, runId, message }) => {
    store.insert('alerts', { flowId, runId, message, at: new Date().toISOString() });
    store.trim('alerts', 1000);
    const topic = env.FLOW_ALERT_NTFY_TOPIC;
    if (!topic) return;
    await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: { Title: `DS Flow: ${flowId} failed`, Priority: 'high' },
      body: message.slice(0, 1000),
      signal: AbortSignal.timeout(10_000),
    });
  };
}
