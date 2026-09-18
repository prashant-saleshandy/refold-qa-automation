# Refold Integration QA — Execution Plan

## 1. What we're testing

SalesHandy connects to four CRMs (**HubSpot, Salesforce, Pipedrive, Zoho**) through a single
middleware layer, **Refold** (product previously called **Cobalt** — the code and some Refold API
responses may still reference `cobalt`). Refold hosts the workflow/automation config (triggers →
actions → field mappings) and executes the actual CRM API calls when a SalesHandy event fires.

We need to verify, for every workflow × action × field-combination we care about, that:

1. SalesHandy correctly detects the trigger event (e.g. a prospect reply) and emits it.
2. Refold's workflow runs, reaches the expected action node(s), resolves the configured field
   values correctly, and reports success.
3. The destination CRM ends up in the exact state implied by the configured fields — not just
   "a record exists", but the specific property values (lead status, lifecycle stage, pipeline,
   deal stage, etc.).

A workflow execution only counts as **PASS** when all three layers agree. "A contact appeared in
HubSpot" alone is not sufficient — it could have the wrong lead status, wrong lifecycle, or have
been created by a different run entirely.

## 2. System map

```
SalesHandy (sequence engine)
   │  prospect replies to a sent email
   ▼
SalesHandy reply-detection → emits trigger event
   ▼
Refold (workflow engine, per linked_account_id)
   │  matches enabled workflow for the trigger
   │  executes each action node with resolved field config
   ▼
Destination CRM API (HubSpot / Salesforce / Pipedrive / Zoho)
```

Each CRM connection in Refold has its own `linked_account_id`. Auth against Refold's API is one
org-level API key (`REFOLD_API_KEY`, `x-api-key` header) shared across all CRM connections, sent
alongside the relevant `linked_account_id` header per call — see §10 for why this key (not a
per-connection session token) is what we standardize on.

## 3. Verification sources, per layer

| Layer | How we verify | Endpoint / mechanism |
|---|---|---|
| SalesHandy | Email sent, reply captured | Existing SalesHandy sequence/task/email APIs (see §6 open item) |
| Refold — run happened | List executions for the workflow, filtered to the run's time window | `GET /api/v2/public/execution?workflow_id=&linked_account_id=&execution_source=Event` |
| Refold — run detail | Per-node status + resolved config used for that specific run | `GET /api/v2/public/execution/{execution_id}` → `nodes[].node_status`, `custom_field_values`, `latest_output` |
| CRM — actual state | Query the created/updated object directly by a correlatable key (email/name) | Native CRM REST API (HubSpot CRM v3, Salesforce REST API, Pipedrive API v1, Zoho CRM API) |

Refold's MCP server (`docs.refold.ai/v3/mcp`) was evaluated and **is not usable for verification** —
it only exposes forward-executing action tools and a dashboard-only "MCP Logs" view with no
programmatic query API. The public REST **Executions API** above is the documented, supported way
to pull run history and is what the harness uses.

Known Refold API quirk: `GET /api/v2/public/execution/{execution_id}` **hangs with no response**
(not even an error) if given a bad/nonexistent execution ID. The harness always resolves the ID via
the list endpoint first and wraps every call in a hard client-side timeout + abort.

## 4. Correlating a test run across three systems

Every test run needs one identifier that's traceable through SalesHandy, Refold, and the CRM,
since none of these systems share a native "test run id."

- Each run generates a `runId` (timestamp + random suffix).
- The prospect email address for that run uses **plus-addressing** off one real mailbox you control,
  e.g. `qa.prospect+hs-replycontact-20260917-ab12@gmail.com`. This lets one real inbox receive all
  test emails and reply from all of them, while SalesHandy/Refold/the CRM all see a distinct email
  address per run — which becomes the correlation key:
  - SalesHandy: prospect record for that address, and its sent/reply timestamps.
  - Refold: execution's time window (narrowed further by `workflow_id`).
  - CRM: contact/deal/company queried by that exact email.
- The harness records `{ runId, prospectEmail, sequenceId, sentAt, repliedAt, executionId, crmObjectId }`
  per test into `test-results/` as the audit trail.

## 5. Test case model

A "test case" = one workflow action + one representative combination of its configurable fields
(not the full cartesian product of options — one valid pair is enough per action, per the working
agreement already reached for e.g. `Create a Contact in Hubspot` → Lead Status = New, Lead
Lifecycle = Subscriber).

Field option lists are **not hardcoded** — they're fetched live from Refold's
`GET /api/v2/public/config/field/{field_id}?workflow_id=` before each run, since these lists can
contain stale/junk entries (observed: a "Test" option with value `"test sgrdfg"` in the live Lead
Status field) and can change over time.

Each CRM's test cases live under `src/workflows/<crm>/fixtures/*.json` as data, decoupled from the
runner logic, so adding a new action/workflow doesn't require touching code.

## 6. Execution flow per phase (fully automated end-to-end; the only manual step is the dashboard)

1. **Setup (automated, once per workflow)** — via `SaleshandyClient` (confirmed working against
   SalesHandy's Open API, see §9): resolve the sender email account by address, create a sequence
   with it attached, create a single Email step, import the uniquely-addressed prospect directly
   onto that step, activate the sequence.
2. **Trigger (automated)** — `TestMailboxClient` reads the outbound email via IMAP and sends a
   threaded SMTP reply, no human needed (see §9). A later phase on the same workflow triggers by
   replying a SECOND time to the same thread instead of repeating setup (see §16).
3. **Wait + verify Refold** — poll `list-executions` for a new execution on the target
   `workflow_id`/`linked_account_id` created after the phase's reply; fetch full detail; assert,
   per action in the phase, that its node's resolved `input_data` matches that action's expected
   config.
4. **Verify CRM** — per action in the phase, query the destination CRM API for the relevant object
   (via the resolved Contact's associations for Deal/Company/Task/Note/Email — see
   `object-verifiers.ts`); assert every field that action cares about (not just presence).
5. **Record + report** — one row per action, `PASS`/`FAIL`/`SKIPPED` with a diff of expected vs.
   actual for any mismatch.

The only manual step left in the whole flow is selecting a phase's actions on the Refold
dashboard's `ActionN` fields before that phase runs — see §15.

## 7. Repo boundaries (per CRM)

Each CRM gets its own client, fixtures, and workflow-runner directory, sharing one core engine:

```
src/
├── core/            # CRM-agnostic engine: types, correlation ids, logger, base runner
├── clients/
│   ├── saleshandy/  # SalesHandy API client (shared — sequence/prospect/email operations)
│   ├── refold/       # Refold Executions/Config API client (shared)
│   └── crms/
│       ├── hubspot/
│       ├── salesforce/
│       ├── pipedrive/
│       └── zoho/     # one API client per CRM — no cross-imports between these
└── workflows/
    ├── hubspot/       # test case fixtures + verifiers, HubSpot only
    ├── salesforce/
    ├── pipedrive/
    └── zoho/
```

No CRM module imports from another CRM module. Adding CRM #5 later means adding one folder under
`clients/crms/` and one under `workflows/`, touching nothing else.

## 8. Rollout order

1. **HubSpot** — `Reply is Received in Saleshandy` → all 9 actions, one field-combo each. (Current
   focus.)
2. Salesforce, Pipedrive, Zoho — same trigger, once the HubSpot path is proven end-to-end and the
   shared core (SalesHandy leg + Refold leg) needs no CRM-specific changes.
3. Expand to other triggers (`Email Sent`, `Contact Created/Updated`, `Deal Created/Updated`,
   `Company Created/Updated`, `Prospect Outcome Updated`) per CRM, reusing the same engine.

## 9. Open items / dependencies

- **SalesHandy API — resolved.** SalesHandy exposes a documented public Open API
  (`open-api.saleshandy.com`, `x-api-key` auth) with everything needed: create sequence with a
  chosen sender (`emailAccountIds`), create an Email step, import a prospect directly onto a step
  (`prospects/import-with-field-name`, creates + attaches in one call), and activate/pause sequences.
  `src/clients/saleshandy/saleshandy-client.ts` implements all of this and is confirmed working
  live (see §10 for the base-URL gotcha).
- **Reply automation — resolved.** `src/clients/mailbox/test-mailbox-client.ts` reads the outbound
  email via IMAP and sends a threaded SMTP reply, fully automating what used to be a manual step.
  This only works because the sender and prospect addresses are both plus-aliases of one real
  Gmail account you control (from a bulk SMTP/IMAP test-mailbox CSV) sharing one app password —
  not a generic "read/reply to any inbox" capability. `/unified-inbox/emails` (SalesHandy's own
  reply API) was investigated as an alternative and parked: it requires an `owners` (user id)
  parameter with no confirmed way to resolve it via the Open API.
  - **Gotcha (confirmed live):** IMAP `SEARCH HEADER/TEXT` silently returns zero matches for a
    subject containing a non-ASCII character (our subjects have an em dash) — it defaults to
    US-ASCII charset. The client fetches envelopes in a `since`-bounded window instead and filters
    on `envelope.subject` in JS, sidestepping the charset issue entirely.
  - **The mailbox itself is a shared, very high-volume warmup pool** (~90k messages, hundreds of
    unrelated emails every few minutes across many plus-aliases, from other people's warmup/test
    activity). `since` (set to `setupStartedAt`) keeps each poll's fetch window small — don't widen
    it without reconsidering performance.
- **Sender choice matters.** Confirmed live: reply-detection did not work reliably from a
  Gsuite/OAuth-connected sender account; switching to an SMTP/IMAP-connected sender fixed it.
  Always use SMTP/IMAP-connected accounts as the sender for this reason.
- **Salesforce auth**: needs its own OAuth (or Connected App username/password flow) — not yet
  configured. Placeholder env vars exist in `.env.example`.

## 10. Environment safety — never touch production

We operate on exactly one pair per CRM: **SalesHandy pyxis (staging) + Refold TEST environment +
that CRM's personal/test account.** We never touch **SalesHandy production + Refold PRODUCTION**,
under any circumstance.

How each boundary is actually enforced (not just documented):

- **Refold**: org API keys are prefixed `tk_` for test, `pk_` for production/live (confirmed per
  Refold's docs). `src/config/safety-guard.ts` → `assertRefoldTestEnvironment()` checks this prefix
  on `REFOLD_API_KEY` and **hard-refuses to run** if it's missing or looks like a production key.
  This runs first thing in the CLI, before any client is constructed. This is a real, mechanical
  check — not just a comment telling you to be careful.
- **SalesHandy**: there is no prefix to check the way Refold has one. The boundary is entirely
  "which gateway host + which key". SalesHandy's public docs advertise a single base URL
  (`open-api.saleshandy.com`) as if it serves every environment, but that's misleading — it
  rejected our pyxis-issued key with a 400 `Invalid token` in a live test. Each environment (e.g.
  pyxis) has its **own gateway host** (mirroring the pattern in `api-docs`'s `SPEC_URL`:
  `https://<env>-open-api-gateway.lifeisgoodforlearner.com`), confirmed working at
  `https://pyxis-open-api-gateway.lifeisgoodforlearner.com/v1`. `SALESHANDY_BASE_URL` in
  `.env`/`.env.example` is pinned to that host. **This is a standing manual responsibility, not a
  code guarantee** — nothing in the harness can detect "this looks like a production key" the way
  it can for Refold, so double-check `SALESHANDY_BASE_URL` and `SALESHANDY_API_TOKEN` any time
  either is changed.
- **HubSpot/Salesforce/Pipedrive/Zoho**: each is your own personal/test account, not a shared
  environment with a production counterpart — no separate guard needed there.

## 11. Declarative multi-workflow suite (`harness.config.json`)

You declare what to test; the harness figures out whether it's safe/ready to test it, and reports
what happened with evidence — no hardcoded fixtures, and no one-action-at-a-time mode (see §16 —
`scripts/run-suite.ts` is the only runner, and every workflow is declared as one or more
**phases**, each phase being the set of actions tested together off one trigger):

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

Run with `npm run test:suite`. For every phase, in order, on every workflow declared:

1. **Preflight** (`src/core/preflight.ts`) — reads the workflow's LIVE config via
   `RefoldClient.getConfig()` for EVERY action in the phase at once, and checks: does the workflow
   exist, is it `enabled`, is each action code actually selected on one of its `ActionN` fields, and
   does every field each action depends on (per `src/workflows/<crm>/field-map.ts`) have a real
   configured value. Any action not ready pauses with the complete list of what's still missing —
   never a silent false pass, and never wastes time running a doomed phase.
2. **Expected values come from the live config**, not a hardcoded fixture — whatever Lead
   Status/Lifecycle (etc.) is actually configured right now is what gets asserted against. Re-running
   the suite after you change the dashboard config picks up the change automatically.
3. **Run** — reuses the same engine as everywhere else in this repo (SalesHandy setup, once per
   workflow → an automated reply per phase, re-using the same thread → one Refold execution check
   per phase, covering every action's node → one CRM object check per action).
4. **Report** — one row per action: `PASS` / `FAIL` (with the specific field mismatches) /
   `SKIPPED` (with the reason), plus evidence (Refold execution id, CRM object id, path to the full
   per-run JSON). A snapshot is written to `test-results/suite-report-<crm>-<workflowId>-<phase>-
   <timestamp>.json` as soon as EACH phase finishes (pass, fail, or skip) — not only at the very
   end — so a crash or interrupt during a later phase never loses an earlier phase's results. One
   more, labeled `suite-report-final-<timestamp>.json`, is written at the end covering every phase
   combined, and is what the final printed table is built from. Every write gets its own fresh
   timestamp — nothing is ever overwritten or deleted, within a run or across separate runs.

**Per-action field maps are hand-maintained, not derivable from Refold's config API.** The config
API's `help_text` values (e.g. `"contact_hubspot"`) are hints, not the actual destination property
key — the only reliable way to learn a field's real destination property is to run the action once
and inspect the resolved `input_data` on the resulting execution (see §3's node-inspection
approach). `src/workflows/hubspot/field-map.ts` holds these once discovered.

## 12. Automating "enable workflow + select action" — investigated, rejected

Refold does have a config-write API (`POST /api/v2/public/config`, org API key, accepting a
`workflows: [{id, enabled, fields}]` array) that looks like it should let the harness flip a
workflow on and pick its action with no dashboard step at all. **Tested live 2026-09-17 and ruled
out**: setting `enabled: true` on one workflow triggered Refold to re-validate every field across
*every* workflow on the whole HubSpot connection, which meant live-refetching dropdown options from
HubSpot's real API for dozens of unrelated fields at once (pipelines, properties, task types,
lists) — several of which immediately hit HubSpot's actual rate limit (`429`, visible in the
response's `field_errors`). Worse, despite no reported error on our specific field, **the workflow
still came back `enabled: false`** — it didn't reliably work at all.

Given the blast radius (touches unrelated workflows, spends real HubSpot API rate-limit budget) and
unreliability, this is not included in the harness. "Enable the workflow + select its action" stays
a manual, one-time dashboard step per workflow under test; §11's preflight check is what makes that
safe to skip verifying by hand every time — it fails fast and tells you exactly what to go fix.

## 13. Learning field mappings from execution history, instead of hit-and-try

Discovering which Refold config field resolves to which destination-CRM property looked at first
like it required running each action once and inspecting its own execution's `input_data` (the
method used to confirm `create-contact`'s Lead Status/Lifecycle fields). That's expensive — a full
SalesHandy → reply → Refold round trip per action.

**Better approach, used 2026-09-17 for the other 7 actions with zero new test runs**: this HubSpot
connection already has 900+ historical Refold executions across every workflow that shares it —
years of prior manual testing and real usage by others in the org. `RefoldClient.listExecutions()`
with no `workflow_id` filter (just `slug: 'hubspot'`) surfaces all of them; `Email Sent from
Saleshandy` in particular shares the *exact same field structure* as `Reply is Received in
Saleshandy` (same field ids for Pipeline/Deal Type/Task Title/etc. — these built-in workflows are
clearly generated from one shared template) and has 205 executions on its own. Fetching detail on
a batch of those and filtering each execution's non-rule, non-search `hubspot`-type nodes for
resolved `input_data` reveals the real payload every action type actually sends — deals, tasks,
notes, companies, logged emails — independent of whether that particular historical run succeeded
or errored (an errored node still shows what it *attempted* to send, which is exactly what we need).

This is now the default first move before testing any new action: **check execution history before
assuming you need a fresh live run to learn a mapping.** It only fails to help for an action nobody
has ever actually exercised on this connection before — at that point, live testing genuinely is the
only way to be sure of the exact slug/payload shape.

## 14. Testing multiple actions in parallel — feasibility notes

Not implemented (the suite runner is a simple sequential loop by design, for correctness and clear
logging), but technically possible with some care about shared resources:

- **Sending-interval throttle is per SENDER ACCOUNT.** Two parallel runs sharing one sender account
  gain nothing — they'd queue behind the same interval regardless of concurrency. Each parallel run
  needs its own sender account (or its own `ensurePromptSend`/Send-Now call, which sidesteps the
  throttle entirely — see §9).
- **IMAP "too many simultaneous connections" is per PROSPECT/mailbox ACCOUNT** (confirmed live
  2026-09-17). Parallel runs must not share one prospect account's IMAP login simultaneously,
  though a small number of brief, non-overlapping connections against the same account is fine —
  the failures we hit were from sustained/repeated connections, not one-off polls.
- **Refold executions and HubSpot objects are naturally isolated** per run already (unique
  correlation email per run, unique sequence per run) — no cross-run interference there regardless
  of concurrency.
- **Practical ceiling**: with 10 distinct Google accounts available (the bulk CSV), true parallelism
  without contention tops out around 5 concurrent runs if each needs its own sender **and** its own
  prospect account (2 accounts/run), or up to ~9-10 if prospect accounts are shared carefully across
  a few concurrent runs using distinct `+N` aliases (since the IMAP connection *limit*, not the
  account itself, is the real constraint — a handful of brief concurrent polls against one account
  is fine, per the point above).
- Implementing it would mean replacing `run-suite.ts`'s sequential `for` loop with a bounded
  `Promise.all`-style pool (e.g. via `p-limit`), each run picking a sender/prospect pair from a
  pool of available accounts rather than the fixed pair in `.env` today.

## 15. Action-level enable/disable — untested, and a real conflict class to know about

**Only workflow-level `enabled` toggling has been tested and rejected (§12).** Swapping which
action is selected on an already-`enabled` workflow (its `Hubspot Action1`–`Action11` fields) is a
narrower operation we have NOT tested — it may or may not share the same blast radius (full
cross-workflow field re-validation, live rate-limit risk). Until/unless that's tested and confirmed
safe, action selection stays a manual dashboard step, same as enabling the workflow itself.
`scripts/run-suite.ts` automates everything else around that: it preflights an entire phase's
actions at once, pauses with the exact, complete list still missing on the dashboard, and runs the
full automated cycle the moment they're all selected.

**Real conflict class identified**: `create-contact`/`update-contact`,
`create-deal`/`update-deal`, and `create-company`/`update-company` are NOT safely combinable
against the same prospect in the same phase/execution. Each `update-*` action is a "search first"
Refold node — it looks up a pre-existing object (by the prospect's email, for contacts) and updates
it. A brand-new, never-seen prospect gives it nothing to find regardless of node execution order —
this isn't a sequencing problem, it's that the two actions encode mutually exclusive starting
assumptions ("prospect is new" vs. "prospect already exists"), the same way a real customer
wouldn't configure both for the same object type on one trigger.

**Fix: two ordered phases, not synthetic seeding.** An earlier version of this harness solved
`update-contact`'s "nothing to find" problem with a direct-API pre-seed step
(`src/workflows/hubspot/update-seed.ts`, now removed). Once the two-phase design (§16) existed,
that became unnecessary: run all `create-*` actions in a "create" phase first, then run all
`update-*` actions in a later "update" phase against the SAME prospect/contact — the objects the
create phase actually made are exactly what update-* needs to find, using Refold's own real search
logic instead of us guessing a matching key. This is also why `update-deal`/`update-company` are
testable now despite their matching key never being confirmed (see field-map.ts's uncertainty note
on `update-deal`) — we don't need to know the key, we just need a real object to already exist,
which the create phase guarantees.

## 16. Consolidated onto phases-only — the one-at-a-time flow is removed

Earlier versions of this harness had two parallel test-execution styles: a one-action-at-a-time
mode (`scripts/run-cycle.ts`, `scripts/run-suite.ts` [the old flat-`actions` version],
`scripts/run-full.ts`, `scripts/setup-run.ts`/`verify-run.ts`, `src/cli/index.ts`) and the
multi-action phased mode (`scripts/run-phases.ts`). Once the phased mode proved out (§15's two-
phase create-then-update design), the one-at-a-time mode added nothing the phased mode couldn't
also do — a single action tested alone is just a phase with one action in it — so it was removed
entirely rather than left to drift out of sync. **`scripts/run-suite.ts` (renamed from
`run-phases.ts`) is now the only entrypoint.**

Removed along with it, since nothing else referenced them:
- `HarnessWorkflowSpec.actions` (the flat, one-at-a-time action list) — `phases` is now the only
  way to declare what to test.
- `src/workflows/hubspot/update-seed.ts` and `HubspotClient.createContact()` — the synthetic
  direct-API seeding mechanism for `update-contact`, superseded by §15's real two-phase chaining.
- `runTestCase`, `runTestCaseAutomated`, `verifyAfterReply` in `src/core/test-runner.ts`, and
  `src/core/results-writer.ts` (per-run `TestRunResult` JSON files) — all only used by the
  one-at-a-time flow. `verifyMultiActionExecution` (§15/§16) and the suite-level report
  (`src/core/report.ts`) are the only result paths now.
- `createHubspotVerifier()` (the deprecated single-fixture wrapper) in `verifier.ts` —
  `createHubspotVerifierForAction(action)` is the only verifier factory now.
- `src/workflows/hubspot/fixtures/reply-received.json` — hardcoded single-test-case fixtures are
  superseded by `harness.config.json`'s declarative phases, which read expected values from
  Refold's live config instead (§11, point 2).

`package.json` scripts were trimmed to just `test:suite` (`scripts/run-suite.ts`) and `preflight`
(`scripts/preflight-only.ts`, also updated to check phases instead of the removed flat actions
list).
