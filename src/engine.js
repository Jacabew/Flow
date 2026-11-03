// DS Flow engine: runs flows step by step, logs every run, retries failures,
// pauses for approvals, and raises alerts. Deterministic: no AI calls in here.
import { stepTypes, resolve } from './steps/index.js';
import { normalizeSchedule } from './scheduler.js';
import { isDsosWrite, dsosConfig } from './connectors/dsos.js';
import { validateAgent, actionOf, modeFor, isShadowStep, isSendAction, usageToday, overLimit, brisbaneDay } from './agents.js';

// Every step attempt is time-limited so a hung step can't block its run forever.
// Override per step with step.timeoutMs. http keeps its own abort (default 30s) with a little headroom here.
export const DEFAULT_STEP_TIMEOUT_MS = 5 * 60_000;

export function stepTimeoutMs(step) {
  if (step.timeoutMs != null) {
    // http aborts its own request at timeoutMs; give it a moment to report the clearer error.
    return step.type === 'http' || step.type === 'dsos' ? step.timeoutMs + 1000 : step.timeoutMs;
  }
  if (step.type === 'http' || step.type === 'dsos') return 30_000 + 1000;
  if (step.type === 'wait') return Math.max(DEFAULT_STEP_TIMEOUT_MS, (step.ms ?? 1000) + 5000);
  return DEFAULT_STEP_TIMEOUT_MS;
}

// External reads retry twice by default. DSOS writes never retry by default: a write that
// timed out may still have landed, and retrying it could double it.
export function defaultRetries(step) {
  if (step.type === 'http') return 2;
  if (step.type === 'dsos') return isDsosWrite(step.method) ? 0 : 2;
  return 0;
}

// Safety cap only. Normal housekeeping is the retention flow (archives runs older than 30 days).
const MAX_RUNS_KEPT = 20000;

// agent_state key for the global pause switch.
export const ALL_AGENTS = '*';

export class Engine {
  constructor({ store, alert = async () => {}, now = () => new Date(), connectors = {} }) {
    this.store = store;
    this.connectors = connectors;
    this.alert = alert;
    this.now = now;
    this.flows = new Map();
    this.agents = new Map();
    this.startedAt = now().toISOString();
  }

  // Agents first, then the flows that belong to them (see src/agents.js).
  registerAgent(agent) {
    const a = validateAgent(agent);
    if (this.agents.has(a.id)) throw new Error(`Agent ${a.id} is registered twice`);
    this.agents.set(a.id, a);
  }

  // Pause switch. id = an agent id, or ALL_AGENTS for every agent. Latest record wins.
  isAgentPaused(id) {
    const last = (key) => this.store.list('agent_state', (r) => r.agentId === key).at(-1)?.paused ?? false;
    return last(ALL_AGENTS) || (id !== ALL_AGENTS && last(id));
  }

  // Returns false for an unknown agent. Resuming continues runs held by the pause.
  async setAgentPaused(id, paused, by = 'jake') {
    if (id !== ALL_AGENTS && !this.agents.has(id)) return false;
    this.store.insert('agent_state', { agentId: id, paused, by, at: this.now().toISOString() });
    if (paused) return true;
    const held = this.store.list('runs', (r) => r.status === 'paused');
    for (const run of held) {
      const flow = this.flows.get(run.flowId);
      if (!flow || this.isAgentPaused(flow.agent)) continue;
      run.status = 'running';
      this.#log(run, `resumed by ${by}`);
      this.store.update('runs', run.id, run);
      await this.#continue(flow, run);
    }
    return true;
  }

  register(flow) {
    if (!flow?.id || !Array.isArray(flow.steps)) throw new Error('A flow needs an id and a steps array');
    for (const s of flow.steps) {
      if (!stepTypes[s.type]) throw new Error(`Flow ${flow.id}: unknown step type "${s.type}"`);
    }
    if (flow.agent !== undefined) {
      const agent = this.agents.get(flow.agent);
      if (!agent) throw new Error(`Flow ${flow.id}: unknown agent "${flow.agent}"`);
      // Catch a missing permission at load time where the target is fixed; dynamic ones are checked per run.
      for (const s of flow.steps) {
        const action = actionOf(s, null);
        if (action && modeFor(agent, action) === 'denied') {
          throw new Error(`Flow ${flow.id}: agent ${agent.id} is not allowed "${action}"`);
        }
      }
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
    if (flow.agent && this.isAgentPaused(flow.agent)) return { skipped: true, reason: 'agent is paused' };

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
      store: this.store, now: this.now, engineStartedAt: this.startedAt, connectors: this.connectors,
    };

    for (let i = run.stepIndex; i < flow.steps.length; i++) {
      const step = flow.steps[i];
      const name = step.name ?? `${i + 1}-${step.type}`;
      const attempts = 1 + (step.retries ?? defaultRetries(step));

      // Agent guardrail: is this agent allowed to do this, and does it need Jake's yes first?
      if (flow.agent) {
        const agent = this.agents.get(flow.agent);
        let action;
        try { action = actionOf(step, ctx); } catch (err) { return this.#fail(flow, run, `${name}: ${err.message}`); }
        const mode = action ? modeFor(agent, action) : 'auto';
        if (mode === 'denied') return this.#fail(flow, run, `${name}: agent ${agent.id} is not allowed "${action}"`);

        // Pause switch: hold before the next step; resume carries on from here.
        if (this.isAgentPaused(agent.id)) {
          run.stepIndex = i;
          run.status = 'paused';
          this.#log(run, `held before ${name}: agent ${agent.id} is paused`);
          this.store.update('runs', run.id, run);
          return { runId: run.id, status: run.status };
        }

        // Daily send/spend limits. Checked before asking for approval and again after it.
        const shadow = isShadowStep(step, this.#dsosWritesLive());
        let usage = null;
        if (!shadow) {
          let spendAud;
          try { spendAud = Number(resolve(step.spendAud, ctx) ?? 0); } catch (err) { return this.#fail(flow, run, `${name}: ${err.message}`); }
          if (!Number.isFinite(spendAud) || spendAud < 0) return this.#fail(flow, run, `${name}: spendAud must be a number ≥ 0`);
          usage = { send: action ? isSendAction(action) : false, spendAud };
          const reason = overLimit(agent, usageToday(this.store, agent.id, this.now()), usage);
          if (reason) return this.#fail(flow, run, `${name}: agent ${agent.id} ${reason}`);
        }

        if (mode === 'approval' && !run.gates?.[i] && !shadow) {
          let detail;
          try { detail = { agent: agent.id, action, body: resolve(step.body, ctx) ?? null }; } catch { detail = { agent: agent.id, action }; }
          const approval = this.store.insert('approvals', {
            runId: run.id, flowId: flow.id, stepName: name, gateStep: i,
            title: `${agent.name}: ${action}?`, detail,
            status: 'pending', createdAt: this.now().toISOString(), decidedAt: null,
          });
          run.stepIndex = i;
          run.status = 'waiting_approval';
          this.#log(run, `agent ${agent.id} needs approval for ${action}`);
          this.store.update('runs', run.id, run);
          return { runId: run.id, status: run.status, approvalId: approval.id };
        }

        // Counted when attempted, not when it succeeds: a failed send may still have gone out.
        if (usage && (usage.send || usage.spendAud > 0)) {
          const now = this.now();
          this.store.insert('agent_usage', {
            agentId: agent.id, flowId: flow.id, runId: run.id, step: name, action,
            send: usage.send, spendAud: usage.spendAud, day: brisbaneDay(now), at: now.toISOString(),
          });
          this.store.trim('agent_usage', 20000); // safety cap; only today's rows matter for limits
        }
      }

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
    if (approval.gateStep != null) {
      // Agent action gate: approving lets that one step run once, in this run only.
      if (approved) run.gates = { ...(run.gates ?? {}), [approval.gateStep]: true };
    } else {
      run.steps[approval.stepName] = { approved, by };
    }

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

  #dsosWritesLive() {
    const c = this.connectors.dsos?.config?.();
    return c ? Boolean(c.writesLive) : dsosConfig().writesLive;
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
    const allAgentsPaused = this.isAgentPaused(ALL_AGENTS);
    const pausedAgents = [...this.agents.keys()].filter((id) => this.isAgentPaused(id)).sort();
    const status = failed.length ? 'red' : pending.length || pausedAgents.length ? 'amber' : 'green';
    const headline = failed.length
      ? `Automations: ${failed.length} failed`
      : pending.length
        ? `Automations: ${pending.length} waiting for approval`
        : allAgentsPaused
          ? 'Automations: all agents paused'
          : pausedAgents.length
            ? `Automations: ${pausedAgents.length} agent${pausedAgents.length === 1 ? '' : 's'} paused`
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
      allAgentsPaused,
      pausedAgents,
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
