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
the phase at once against Refold's live config (skips immediately with the exact, complete list
still missing if any aren't selected — this script runs unattended, so it never pauses waiting for
a keypress, see `execution-plan.md` §18), then runs SalesHandy setup → an automated reply (via IMAP
read + SMTP send, see `execution-plan.md` §9) → one Refold execution check covering every action's
node → one CRM object check per action, then moves to the next phase by replying a **second time to
the same email thread** (confirmed this re-triggers the workflow) so a later phase like "update" can
act on real objects an earlier phase like "create" already made — no synthetic seeding needed.

Writes ONE combined report per workflow, updated as soon as each phase finishes (never only at the
end — nothing is lost if a later phase crashes), under
`test-results/<runNumber>/<workflowId>/report.md` — every action from every phase in one table
(Action | Pass/Failed | If failed why | What happened), with a `result.json` alongside it holding
the raw row data. `runNumber` is a plain incrementing integer (1, 2, 3, ...), shared across the
whole suite run, including phases run in a later `--resume` invocation — see `execution-plan.md`
§22/§29/§30.

**Testing a later phase separately, after a dashboard switch**: since this script can't pause
mid-run for you to change the dashboard (§18), run it once per phase instead, with `--resume` on
every call after the first — the same `harness.config.json` covers every phase, since `active`
(per workflow spec) is how you turn workflows on/off, not separate scoped config files. E.g. after
switching the dashboard from create-actions to update-actions, just re-run
`npx tsx scripts/run-suite.ts --resume`. `--resume` picks up the exact same prospect/contact the
first run made (see `execution-plan.md` §21) instead of starting over, and reports for the new
phase's actions land in the same timestamped top-level folder as the first run.

Use `npm run preflight [path/to/harness.config.json]` to check readiness (which actions are/aren't
selected per phase) without running anything — no SalesHandy sequence, no email, no CRM writes.

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
