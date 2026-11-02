// Agent registry. An agent is a named job (e.g. "enquiry responder") with a list of what it
// may touch. Flows opt in with `agent: '<id>'`; flows without one are system flows and are
// not restricted (heartbeat, watchdog, retention...).
//
// Agent file (agents/<id>.js, default export):
//   {
//     id: 'enquiry-responder',
//     name: 'Enquiry responder',
//     job: 'Reply to website enquiries and book the intro chat.',
//     actions: {
//       'dsos:GET /api/v1/leads*': 'auto',      // may do without asking
//       'dsos:POST /api/v1/leads': 'approval',  // pauses for Jake's yes when it would really happen
//     },
//   }
//
// Action strings: '<connector>:<METHOD> <target>'.
//   dsos → target is the path (/api/v1/...); http → target is the host (api.example.com).
//   '*' in a pattern matches any run of characters. Anything not listed is DENIED.
// Internal steps (code, if, wait, log, approval) are not actions and are always allowed.
// Shadow writes (logged, not sent) are checked for permission but never need approval:
// nothing happens, so there is nothing to approve.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDsosWrite } from './connectors/dsos.js';
import { resolve } from './steps/index.js';

export const MODES = ['auto', 'approval'];
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ACTION_RE = /^[a-z][a-z0-9-]*:[A-Z*]+ \S+$/;

export function validateAgent(agent) {
  if (!agent || typeof agent !== 'object') throw new Error('An agent must be an object');
  if (!ID_RE.test(agent.id ?? '')) throw new Error(`Agent id must be lower-case letters, digits and dashes (got ${JSON.stringify(agent.id)})`);
  if (!agent.name || !agent.job) throw new Error(`Agent ${agent.id}: needs a name and a job`);
  const actions = agent.actions ?? {};
  if (typeof actions !== 'object' || Array.isArray(actions)) throw new Error(`Agent ${agent.id}: actions must be an object`);
  for (const [pattern, mode] of Object.entries(actions)) {
    if (!ACTION_RE.test(pattern)) throw new Error(`Agent ${agent.id}: bad action "${pattern}" (want "connector:METHOD target")`);
    if (!MODES.includes(mode)) throw new Error(`Agent ${agent.id}: action "${pattern}" mode must be auto or approval (got ${JSON.stringify(mode)})`);
  }
  return { id: agent.id, name: agent.name, job: agent.job, actions: { ...actions } };
}

function patternToRegExp(pattern) {
  return new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
}

// 'auto' | 'approval' | 'denied'. When several patterns match, the strictest wins.
export function modeFor(agent, action) {
  let mode = 'denied';
  for (const [pattern, m] of Object.entries(agent.actions)) {
    if (!patternToRegExp(pattern).test(action)) continue;
    if (m === 'approval') return 'approval';
    mode = m;
  }
  return mode;
}

// The action a step performs, or null for internal steps.
// `ctx` is needed when path/url are functions; pass null for a static (load-time) check,
// which returns undefined when the target can't be known yet.
export function actionOf(step, ctx) {
  if (step.type === 'dsos') {
    const p = typeof step.path === 'function' ? (ctx ? resolve(step.path, ctx) : undefined) : step.path;
    if (p === undefined) return undefined;
    return `dsos:${String(step.method ?? 'GET').toUpperCase()} ${p}`;
  }
  if (step.type === 'http') {
    const u = typeof step.url === 'function' ? (ctx ? resolve(step.url, ctx) : undefined) : step.url;
    if (u === undefined) return undefined;
    let host;
    try { host = new URL(u).host; } catch { host = String(u); }
    return `http:${String(step.method ?? 'GET').toUpperCase()} ${host}`;
  }
  return null;
}

// True when running the step would only be logged, not done (a DSOS write in shadow).
export function isShadowStep(step, dsosWritesLive) {
  return step.type === 'dsos' && isDsosWrite(step.method) && !(step.live === true && dsosWritesLive);
}

export async function loadAgents(engine, dir) {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js')).sort()) {
    const mod = await import(pathToFileURL(path.join(dir, f)).href);
    engine.registerAgent(mod.default);
  }
}

// Read-only view for GET /api/agents.
export function agentsReport(engine, sinceHours = 24) {
  const since = engine.now().getTime() - sinceHours * 3600_000;
  return [...engine.agents.values()].map((a) => {
    const flows = [...engine.flows.values()].filter((f) => f.agent === a.id).map((f) => f.id);
    const runs = engine.store.list('runs', (r) => flows.includes(r.flowId) && Date.parse(r.startedAt) >= since);
    return {
      id: a.id,
      name: a.name,
      job: a.job,
      flows: flows.map((id) => ({ id, enabled: engine.isEnabled(id) })),
      auto: Object.keys(a.actions).filter((k) => a.actions[k] === 'auto'),
      needsApproval: Object.keys(a.actions).filter((k) => a.actions[k] === 'approval'),
      runs24h: runs.length,
      failed24h: runs.filter((r) => r.status === 'failed').length,
    };
  });
}
