// Built-in step types. A step is { type, name?, ...config }.
// Each handler receives (step, ctx) and returns output that is stored at ctx.steps[name].
// Throwing marks the step failed (and triggers retry if the step allows it).
//
// Special return: { __pause: 'approval', ... } tells the engine to stop and wait for a human.

export const stepTypes = {
  // Call any HTTP API. Connectors are built on top of this.
  async http(step, ctx) {
    const url = resolve(step.url, ctx);
    const res = await fetch(url, {
      method: step.method ?? 'GET',
      headers: { 'content-type': 'application/json', ...(resolve(step.headers, ctx) ?? {}) },
      body: step.body !== undefined ? JSON.stringify(resolve(step.body, ctx)) : undefined,
      signal: AbortSignal.timeout(step.timeoutMs ?? 30000),
    });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}: ${String(text).slice(0, 300)}`);
    return { status: res.status, body };
  },

  // Plain JavaScript: step.fn(ctx) => value. For shaping data between steps.
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
  async wait(step) {
    await new Promise((r) => setTimeout(r, step.ms ?? 1000));
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
