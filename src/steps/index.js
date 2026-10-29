// Built-in step types. A step is { type, name?, ...config }.
// Each handler receives (step, ctx) and returns output that is stored at ctx.steps[name].
// Throwing marks the step failed (and triggers retry if the step allows it).
//
// Special return: { __pause: 'approval', ... } tells the engine to stop and wait for a human.

import { makeDsosClient } from '../connectors/dsos.js';

let defaultDsos;
const dsosClient = (ctx) => ctx.connectors?.dsos ?? (defaultDsos ??= makeDsosClient());

export const stepTypes = {
  // Call any HTTP API. Connectors are built on top of this.
  async http(step, ctx) {
    const url = resolve(step.url, ctx);
    const res = await fetch(url, {
      method: step.method ?? 'GET',
      headers: { 'content-type': 'application/json', ...(resolve(step.headers, ctx) ?? {}) },
      body: step.body !== undefined ? JSON.stringify(resolve(step.body, ctx)) : undefined,
      signal: ctx.signal
        ? AbortSignal.any([ctx.signal, AbortSignal.timeout(step.timeoutMs ?? 30000)])
        : AbortSignal.timeout(step.timeoutMs ?? 30000),
    });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}: ${String(text).slice(0, 300)}`);
    return { status: res.status, body };
  },

  // DSOS API. { type: 'dsos', method?, path: '/api/v1/...', query?, body?, live? }
  // Writes are shadow (logged, not sent) unless live: true AND FLOW_DSOS_WRITES=live.
  async dsos(step, ctx) {
    const out = await dsosClient(ctx).request({
      method: step.method ?? 'GET',
      path: resolve(step.path, ctx),
      query: resolve(step.query, ctx),
      body: resolve(step.body, ctx),
      live: step.live === true,
      signal: ctx.signal,
      timeoutMs: step.timeoutMs ?? 30000,
    });
    if (out.shadow && ctx.store) {
      ctx.store.insert('shadow', {
        connector: 'dsos', flowId: ctx.flowId, runId: ctx.runId,
        at: (ctx.now?.() ?? new Date()).toISOString(), ...out.wouldSend,
      });
      ctx.store.trim('shadow', 5000);
    }
    return out;
  },

  // Plain JavaScript: step.fn(ctx) => value. For shaping data between steps.
  // Time-limited like every step (default 5 min, step.timeoutMs to change); ctx.signal aborts on timeout.
  async code(step, ctx) {
    return await step.fn(ctx);
  },

  // Branch: if step.when(ctx) is false, the remaining steps are skipped.
  async if(step, ctx) {
    const pass = Boolean(await step.when(ctx));
    if (!pass) ctx.stop = `condition "${step.name ?? 'if'}" was false`;
    return { pass };
  },

  // Wait a fixed time (short waits only; long waits should be a new scheduled trigger).
  async wait(step, ctx) {
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, step.ms ?? 1000);
      ctx?.signal?.addEventListener('abort', () => { clearTimeout(t); reject(ctx.signal.reason); }, { once: true });
    });
    return { waitedMs: step.ms ?? 1000 };
  },

  // Human-in-the-loop. Pauses the run until approved or rejected via the approval inbox.
  async approval(step, ctx) {
    return {
      __pause: 'approval',
      title: resolve(step.title, ctx) ?? 'Approval needed',
      detail: resolve(step.detail, ctx) ?? null,
    };
  },

  // Write a line to the run log (useful for summaries the Mon/Fri check can read).
  async log(step, ctx) {
    return { message: resolve(step.message, ctx) };
  },
};

// Values can be literals or functions of ctx, so flows can use earlier step outputs.
export function resolve(value, ctx) {
  return typeof value === 'function' ? value(ctx) : value;
}
