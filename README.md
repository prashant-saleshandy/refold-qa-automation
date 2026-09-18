# Refold QA Automation

Automated QA harness for SalesHandy → Refold → CRM integration workflows
(HubSpot, Salesforce, Pipedrive, Zoho).

**Read [`knowledge_base/execution-plan.md`](knowledge_base/execution-plan.md) first** — it covers
what's being tested, why, the system architecture, how a test run is correlated across three
different systems, and the current open items/dependencies.

## Setup

```bash
nvm use            # reads .nvmrc (Node 24.21.0)
npm install
cp .env.example .env
# fill in .env: Refold linked-account tokens, HubSpot access token,
# and SALESHANDY_TEST_PROSPECT_BASE_EMAIL (a real mailbox you control)
```

## Running

```bash
npm run test:suite
```

This is the only entrypoint — there's no separate one-action-at-a-time mode. It reads
`harness.config.json`, where you declare, per workflow, one or more **phases**: sets of actions
tested together off a single trigger. Testing one action in isolation is just a phase with one
action in it:

```json
{
  "workflows": {
    "hubspot": [
      {
        "workflowId": "681368981acc0cbcd16295a9",
        "phases": [
          { "name": "create", "actions": ["create-contact", "create-deal"] },
          { "name": "update", "actions": ["update-contact", "update-deal"] }
        ]
      }
    ]
  }
}
```

For each phase, fully automated, no manual steps beyond the dashboard: preflights every action in
the phase at once against Refold's live config (pauses with the exact, complete list still missing
if any aren't selected — never guesses, never runs a doomed phase), then runs SalesHandy setup →
an automated reply (via IMAP read + SMTP send, see `execution-plan.md` §9) → one Refold execution
check covering every action's node → one CRM object check per action, then moves to the next
phase by replying a **second time to the same email thread** (confirmed this re-triggers the
workflow) so a later phase like "update" can act on real objects an earlier phase like "create"
already made — no synthetic seeding needed. Writes a report snapshot to `test-results/` as soon as
EACH phase finishes (never only at the end — nothing is lost if a later phase crashes), plus one
final combined report covering every phase; every file gets a fresh timestamp, so nothing is ever
overwritten or deleted, within a run or across separate runs. See `execution-plan.md` §11 for the
full design and §12 for why "also automate enabling the workflow/selecting its actions" was
investigated and rejected.

Use `npm run preflight` to check readiness (which actions are/aren't selected per phase) without
running anything — no SalesHandy sequence, no email, no CRM writes.

Salesforce, Pipedrive, and Zoho are scaffolded (client + verifier boundaries exist under
`src/clients/crms/<crm>/` and `src/workflows/<crm>/`) but not yet implemented — see
`knowledge_base/execution-plan.md` §8 for rollout order and §9 for open items blocking them
(mainly: CRM-specific auth setup).

**Never point this at production.** See `knowledge_base/execution-plan.md` §10 — the harness
hard-refuses to run if `REFOLD_API_KEY` isn't a test-prefixed (`tk_`) key, but there's no equivalent
automatic check for SalesHandy; `SALESHANDY_BASE_URL`/`SALESHANDY_API_TOKEN` must stay pointed at
the pyxis (staging) gateway and a pyxis-issued key.

## Structure

```
harness.config.json # declares which (crm, workflow, action) combos to test
src/
├── config/         # env loading/validation, environment safety guard
├── core/           # CRM-agnostic engine: types, correlation ids, runner, preflight, report, logger
├── clients/
│   ├── saleshandy/ # SalesHandy API client (shared)
│   ├── refold/     # Refold Executions/Config API client (shared)
│   ├── mailbox/    # IMAP read + SMTP send for automated reply (shared)
│   └── crms/       # one client per CRM — no cross-imports between them
└── workflows/      # one folder per CRM: field-maps (Refold field id → CRM property) + verifiers
scripts/            # entrypoints — run-suite.ts is the main one
```

Adding a new workflow/action for an already-supported CRM = add one entry to
`harness.config.json`, and a field-map entry (`src/workflows/<crm>/field-map.ts`) if the action
uses fields not already mapped. No other code changes needed.
