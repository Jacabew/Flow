# DS Flow — Project Brief
*Working name. Kickoff: 23 Oct 2026.*

## What this is
DarkSpace's own basic automation and agent manager, a home-built alternative to n8n. It runs triggers → steps → actions, with logging, retries, approvals and alerts. DSOS is its first user. Later it should serve other projects (marketing system, Creative Buddy, etc.).

## Why build it
- No subscriptions. Jake doesn't want ongoing SaaS fees.
- DSOS already has most of the parts: data, tools (Xero, Google, email), triggers and AI steps.
- The missing layer is control: an agent registry, an approval inbox, a run log, alerts and guardrails.
- This is the "Business Agents" and "Autonomy / Mission Control" part of the DSOS December 2026 vision.

## Hard constraint: background build
- Jake gives **2–5 min a day** (micro-checks scheduled by DS PA) and **one 30 min session a week**.
- Claude makes the calls and logs its assumptions. Jake vetoes in the weekly session.
- Claude asks Jake mid-week only when a decision is irreversible.
- This project must never compete with DSOS alterations. Those are handled in the DSOS Build project.

## Scope (basic version)
**In:**
- Triggers: schedule, webhook, DSOS events
- Steps: HTTP call, email, AI call, DSOS action, if/else, wait, approval
- Run log on every run; auto-retry on external calls; failure alerts; HUB heartbeat check
- UI: flow list, on/off toggle, run history, approval inbox, Mission Control tile ("Automations: all green / X failed")
- Agent registry: each agent's job, what it may touch, and what it can do without asking
- Guardrails: send and spend limits, pause switch per agent

**Out (deliberately):**
- Drag-and-drop canvas. Jake describes a flow and Claude writes it.
- A big connector library. Each connector is built when it's needed.

## Phases (about one a week)
1. **Engine and run log.** Triggers, steps, retries, alerts. Nothing visible to Jake yet.
2. **Approval inbox and Mission Control tile.** Jake tries it on his phone (5 min).
3. **Move existing automations onto it:** daily Xero back-feed, recurring invoices (workshop rent), enquiry responder. Each runs alongside the current setup first and only switches over once proven. Live invoicing is never put at risk.
4. **Agent registry and first agent:** the enquiry responder (form → tailored email → booking → call reminder).
5. **Package as a standalone module** with a clean API for other projects.

**Target:** basic version running by end of November 2026.

## Decisions (23 Oct 2026)
1. **Own repo.** DS Flow is standalone and reusable across DarkSpace systems and other builds. DSOS connects to it over an API, just like any other client would.
2. **Jake's time** (on the JW DARKSPACE calendar):
   - Mon and Fri, 7:30am: 5 min check
   - Wed, 8:00am: 30 min review
3. **Self-managing build.** Today DSOS updates rely on Jake copy-pasting prompts into Claude Code. DS Flow must not work that way. It cannot stall waiting on Jake for permissions.

## Phase 0: self-running build pipeline (do first)
Automated checks replace Jake's approval:
- **Scheduled build runs.** Claude scheduled tasks work through the phase list on their own, with automatic approval enabled on the task (Jake switches this on once, if the org allows it).
- **Gate = tests.** A change only merges to `main` if the automated tests pass. No human click.
- **Auto-deploy on the HUB.** A small service pulls `main`, restarts DS Flow, and runs a health check. If the check fails, it **auto-rolls back** to the last good version and logs why.
- **Reporting.** Each run writes a one-line summary to the run log. The Mon/Fri check shows only what needs a yes/no.
- **One-time setup by Jake (~30 min, first Wednesday session):** create the GitHub repo, install the auto-deploy service on the HUB, and enable automatic approval on the scheduled build task.
- **Blast radius.** Autonomous runs only touch the DS Flow repo. They never touch live DSOS code. Once this pipeline has proven itself, the same setup can be offered for DSOS updates.

## Context
- DSOS: dsos.darkspace.au. Runs on the HUB (Windows; Node/Express; Caddy; NSSM).
- Repo: Jacabew/DarkSpace-Operating-System---Private
- Xero is the accounting source of truth. DSOS is the operational source of truth.
- n8n's self-hosted Community edition is free and stays the fallback, e.g. if the marketing system needs many third-party connectors fast.
