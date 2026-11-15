// Failure alerts. Always recorded in the store. Optionally pushed to Jake's phone.
// FLOW_ALERT_NTFY_TOPIC: push via ntfy.sh (free, no account, install the ntfy app and
// subscribe to the same private topic name), or FLOW_SECRETS_DIR\ntfy-topic.txt, read on
// every alert so a topic added later works without a restart. Neither = only record alerts.
import fs from 'node:fs';
import path from 'node:path';

function ntfyTopic(env) {
  if (env.FLOW_ALERT_NTFY_TOPIC) return env.FLOW_ALERT_NTFY_TOPIC;
  if (!env.FLOW_SECRETS_DIR) return null;
  try {
    return fs.readFileSync(path.join(env.FLOW_SECRETS_DIR, 'ntfy-topic.txt'), 'utf8').trim() || null;
  } catch { return null; }
}

export function makeAlerter(store, env = process.env) {
  return async ({ flowId, runId, message }) => {
    store.insert('alerts', { flowId, runId, message, at: new Date().toISOString() });
    store.trim('alerts', 1000);
    const topic = ntfyTopic(env);
    if (!topic) return;
    await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: { Title: `DS Flow: ${flowId} failed`, Priority: 'high' },
      body: message.slice(0, 1000),
      signal: AbortSignal.timeout(10_000),
    });
  };
}
