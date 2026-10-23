// Entry point. Config via environment variables (set by the HUB service installer):
//   FLOW_PORT      default 5680
//   FLOW_DATA_DIR  default ./data   (keep OUTSIDE OneDrive)
//   FLOW_API_KEY   required for /api/*
//   FLOW_ALERT_NTFY_TOPIC  optional phone push alerts
//   FLOW_STATUS_DIR  optional; daily.json etc. written here (OneDrive\FLOW\status on the HUB)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { startScheduler } from './scheduler.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.FLOW_PORT ?? 5680);

const { server, engine, ready } = createApp({
  dataDir: process.env.FLOW_DATA_DIR ?? path.join(root, 'data'),
  apiKey: process.env.FLOW_API_KEY,
  flowsDir: path.join(root, 'flows'),
});

await ready;
startScheduler(engine);
server.listen(port, '127.0.0.1', () => {
  console.log(`DS Flow listening on http://127.0.0.1:${port} with ${engine.flows.size} flow(s)`);
});
