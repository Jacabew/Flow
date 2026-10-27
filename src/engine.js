// DS Flow engine: runs flows step by step, logs every run, retries failures,
// pauses for approvals, and raises alerts. Deterministic: no AI calls in here.
import { stepTypes } from './steps/index.js';
import { normalizeSchedule } from './scheduler.js';

// Every step attempt is time-limited so a hung step can't block its run forever.
// Override per step with step.timeoutMs. http keeps its own abort (default 30s) with a little headroom here.
export const DEFAULT_STEP_TIMEOUT_MS = 5 * 60_000;

export function stepTimeoutMs(step) {
  if (step.timeoutMs != null) {
    // http aborts its own request at timeoutMs; give it a moment to report the clearer error.
    return step.type === 'http' ? step.timeoutMs + 1000 : step.timeoutMs;
  }
  if (step.type === 'http') return 30_000 + 1000;
  if (step.type === 'wait') return Math.max(DEFAULT_STEP_TIMEOUT_MS, (step.ms ?? 1000) + 5000);
  return DEFAULT_STEP_TIMEOUT_MS;
}

// Safety cap only. Normal housekeeping is the retention flow (archives runs older than 30 days).
const MAX_RUNS_KEPT = 20000;

export class Engine {
  constructor({ store, alert = async () => {}, now = () => new Date() }) {
    this.store = store;
    this.alert = alert;
    this.now = now;
    this.flows = new Map();
    this.startedAt = now().toISOString();
  }

  register(flow) {
    if (!flow?.id || !Array.isArray(flow.steps)) throw new Error('A flow needs an id and a steps array');
    for (const s of flow.steps) {
      if (!stepTypes[s.type]) throw new Error(`Flow ${flow.id}: unknown step type "${s.type}"`);
    }
    if (flow.schedule) {
      try { normalizeSchedule(flow.schedule); } catch (err) { throw new Error(`Flow ${flow.id}: ${err.message}`); }
    }
    this.flows.set(flow.id, { enabled: true, ...flow });
  }

  isEnabled(id) {
    const override = this.store.list('flow_state', (r) => r.flowId === id).at(-1);
    const flow = this.flows.get(id);
    return override ? override.enabled : Boolean(flow?.enabled);
  }

  setEnabled(id, enabled) {
    if (!this.flows.has(id)) return false;
    this.store.insert('flow_state', { flowId: id, enabled, at: this.now().toISOString() });
    return true;
  }

  // Start a new run. `input` is the trigger payload (webhook body, schedule info, etc).
  async trigger(flowId, input = {}, source = 'manual') {
    const flow = this.flows.get(flowId);
    if (!flow) throw new Error(`Unknown flow "${flowId}"`);
    if (!this.isEnabled(flowId)) return { skipped: true, reason: 'flow is paused' };

    const run = this.store.insert('runs', {
      flowId,
      source,
      status: 'running',
      input,
      startedAt: this.now().toISOString(),
      finishedAt: null,
      stepIndex: 0,
      steps: {},
      log: [],
      error: null,
    });
    this.store.trim('runs', MAX_RUNS_KEPT);
    return this.#continue(flow, run);
  }

  async #continue(flow, run) {
    // store/now/engineStartedAt let system flows (e.g. watchdog) read run history.
    const ctx = {
      input: run.input, steps: run.steps, flowId: flow.id, runId: run.id, stop: null,
      store: this.store, now: this.now, engineStartedAt: this.startedAt,
    };

    for (let i = run.stepIndex; i < flow.steps.length; i++) {
      const step = flow.steps[i];
      const name = step.name ?? `${i + 1}-${step.type}`;
      const attempts = 1 + (step.retries ?? (step.type === 'http' ? 2 : 0));

      let output;
      let lastErr;
      for (let a = 1; a <= attempts; a++) {
        try {
          output = await withTimeout(stepTypes[step.type], step, ctx, stepTimeoutMs(step));
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          this.#log(run, `step ${name} attempt ${a}/${attempts} failed: ${err.message}`);
          if (a < attempts) await sleep(step.retryDelayMs ?? 1000 * 2 ** (a - 1));
        }
      }

      if (lastErr) return this.#fail(flow, run, `${name}: ${lastErr.message}`);

      if (output?.__pause === 'approval') {
        const approval = this.store.insert('approvals', {
          runId: run.id,
          flowId: flow.id,
          stepName: name,
          title: output.title,
          detail: output.detail,
          status: 'pending',
          createdAt: this.now().toISOString(),
          decidedAt: null,
        });
        run.stepIndex = i + 1;
        run.status = 'waiting_approval';
        this.#log(run, `waiting for approval: ${output.title}`);
        this.store.update('runs', run.id, run);
        return { runId: run.id, status: run.status, approvalId: approval.id };
      }

      run.steps[name] = output ?? null;
      run.stepIndex = i + 1;
      this.store.update('runs', run.id, run);

      if (ctx.stop) {
        this.#log(run, `stopped early: ${ctx.stop}`);
        break;
      }
    }

    run.status = 'success';
    run.finishedAt = this.now().toISOString();
    this.store.update('runs', run.id, run);
    return { runId: run.id, status: run.status };
  }

  // Call once at start-up, before the scheduler. Any run still "running" was cut off by a
  // restart or crash (single process), so mark it failed and alert. Approval waits are left alone.
  async recoverInterrupted() {
    const stuck = this.store.list('runs', (r) => r.status === 'running');
    for (const run of stuck) {
      this.#log(run, 'interrupted by a restart');
      await this.#fail({ id: run.flowId }, run, `interrupted by a restart (step ${run.stepIndex + 1})`);
    }
    return { recovered: stuck.length };
  }

  async decide(approvalId, decision, by = 'jake') {
    const approval = this.store.get('approvals', approvalId);
    if (!approval) throw new Error('Approval not found');
    if (approval.status !== 'pending') return { status: approval.status, already: true };

    const approved = decision === 'approve';
    this.store.update('approvals', approvalId, {
      status: approved ? 'approved' : 'rejected',
      decidedAt: this.now().toISOString(),
      decidedBy: by,
    });

    const run = this.store.get('runs', approval.runId);
    const flow = this.flows.get(approval.flowId);
    run.steps[approval.stepName] = { approved, by };

    if (!approved) {
      run.status = 'rejected';
      run.finishedAt = this.now().toISOString();
      this.#log(run, `rejected by ${by}`);
      this.store.update('runs', run.id, run);
      return { runId: run.id, status: run.status };
    }
    this.#log(run, `approved by ${by}`);
    run.status = 'running';
    return this.#continue(flow, run);
  }

  async #fail(flow, run, message) {
    run.status = 'failed';
    run.error = message;
    run.finishedAt = this.now().toISOString();
    this.store.update('runs', run.id, run);
    try {
      await this.alert({ flowId: flow.id, runId: run.id, message });
    } catch {
      // An alert failure must never crash the engine.
    }
    return { runId: run.id, status: run.status, error: message };
  }

  #log(run, message) {
    run.log.push({ at: this.now().toISOString(), message });
  }

  // One-glance status for the Mission Control tile. Shape is frozen as schema 1 and
  // documented in docs/API.md: fields may be added, never renamed or removed.
  summary(sinceHours = 24) {
    const now = this.now();
    const since = now.getTime() - sinceHours * 3600_000;
    const recent = this.store.list('runs', (r) => Date.parse(r.startedAt) >= since);
    const failed = recent.filter((r) => r.status === 'failed');
    const pending = this.store.list('approvals', (a) => a.status === 'pending');
    const status = failed.length ? 'red' : pending.length ? 'amber' : 'green';
    const headline = failed.length
      ? `Automations: ${failed.length} failed`
      : pending.length
        ? `Automations: ${pending.length} waiting for approval`
        : 'Automations: all green';
    return {
      schema: 1,
      generatedAt: now.toISOString(),
      sinceHours,
      ok: failed.length === 0,
      status,
      headline,
      runs: recent.length,
      failed: failed.length,
      failedFlows: [...new Set(failed.map((r) => r.flowId))].sort(),
      lastFailureAt: failed.length ? failed.map((r) => r.startedAt).sort().at(-1) : null,
      pendingApprovals: pending.length,
      flows: [...this.flows.keys()].map((id) => ({ id, enabled: this.isEnabled(id) })),
    };
  }
}

// Runs one step attempt with a time limit. ctx.signal aborts on timeout so steps that can
// stop cleanly (fetch, timers) do; work that ignores the signal is abandoned, not killed.
async function withTimeout(handler, step, ctx, ms) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`timed out after ${ms} ms`);
      controller.abort(err);
      reject(err);
    }, ms);
  });
  ctx.signal = controller.signal; // same ctx object: steps like `if` set ctx.stop on it
  try {
    return await Promise.race([handler(step, ctx), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
