/**
 * The suite runner — the only test-execution mode in this harness. For each
 * declared phase (e.g. "create" then "update") on a workflow, preflights
 * ALL of that phase's actions at once, pauses once with the full list to
 * select in the dashboard, then runs them all together off a SINGLE shared
 * prospect/sequence — one execution per phase, one node per action. A
 * single action tested alone is just a workflow with one phase containing
 * one action — there's no separate one-at-a-time mode.
 *
 * A later phase (e.g. "update") reuses the SAME prospect/contact an earlier
 * phase (e.g. "create") already made real objects for — no synthetic
 * seeding needed. It triggers by replying a SECOND time to the same email
 * thread — confirmed with the SalesHandy team that a second reply re-fires
 * "Reply is Received" — rather than sending a new email.
 *
 * Usage: npx tsx scripts/run-suite.ts [path/to/harness.config.json] [--resume]
 *
 * --resume: skip SalesHandy setup entirely and continue against the
 * prospect/sequence/contact saved by a PREVIOUS run of this script for the
 * same (crm, workflowId) — see src/core/run-context-store.ts. Use this to
 * test a LATER phase (e.g. "update") against real objects an EARLIER
 * phase (e.g. "create") already made, in a separate invocation, with a
 * dashboard action-switch happening in between. Without --resume, a fresh
 * prospect is generated and setup runs from scratch.
 */
import 'dotenv/config';
import dns from 'node:dns';
import net from 'node:net';
import { TestMailboxClient } from '../src/clients/mailbox/test-mailbox-client.js';
import { RefoldClient } from '../src/clients/refold/refold-client.js';
import { SaleshandyEdgeClient } from '../src/clients/saleshandy/saleshandy-edge-client.js';
import { SaleshandyClient } from '../src/clients/saleshandy/saleshandy-client.js';
import { optionalEnv, requireEnv } from '../src/config/env.js';
import { assertRefoldTestEnvironment } from '../src/config/safety-guard.js';
import { buildProspectEmail, generateRunId, generateShortToken } from '../src/core/correlation.js';
import { loadHarnessConfig } from '../src/core/harness-config.js';
import { preflightWorkflowAction } from '../src/core/preflight.js';
import { getNextRunNumber, printSuiteReport, writeWorkflowReport } from '../src/core/report.js';
import { loadRunContext, saveRunContext } from '../src/core/run-context-store.js';
import { autoReply, cleanupPreviousTestData, ensurePromptSend, setupSaleshandySequence, triggerBounce, triggerLinkClick, triggerOutcomeUpdate, triggerUnsubscribe, verifyMultiActionExecution } from '../src/core/test-runner.js';
import type { CrmSlug, RunContext, SuiteReportRow } from '../src/core/types.js';
import { HUBSPOT_FIELD_MAPS_BY_WORKFLOW } from '../src/workflows/hubspot/field-map-registry.js';
import { getTriggerType, HUBSPOT_OUTCOME_GATE_FIELDS_BY_WORKFLOW } from '../src/workflows/hubspot/outcome-gate-registry.js';
import { HUBSPOT_PROSPECT_FIELD_MAPPINGS } from '../src/workflows/hubspot/prospect-field-mappings.js';
import { createHubspotVerifierForAction } from '../src/workflows/hubspot/verifier.js';

// Confirmed live 2026-09-23/24: this environment's real problem is Node's
// Happy Eyeballs (RFC 6555) dual-stack connection racing, not DNS ordering.
// IPv6 is entirely unreachable here (curl -6 fails instantly), but Node's
// `net.connect` races IPv4 + IPv6 addresses in parallel by default — and on
// this environment that race intermittently times out on EVERY resolved
// address, including the IPv4 ones a plain `curl -4` reaches in ~1s every
// time. `dns.setDefaultResultOrder('ipv4first')` alone (kept below) only
// reorders which address is tried first; it doesn't stop the parallel race.
// Disabling autoSelectFamily forces sequential, single-address connects —
// confirmed live this eliminates the ETIMEDOUT/ENETUNREACH failures against
// pyxis.lifeisgoodforlearner.com entirely.
net.setDefaultAutoSelectFamily(false);
dns.setDefaultResultOrder('ipv4first');

// Only HubSpot is wired up today — see execution-plan.md §8 for rollout order.
// Field maps are keyed by workflowId first — the same action code (e.g.
// "create-deal") has different Refold field ids on different workflows.
// See field-map-registry.ts.
const CRM_FIELD_MAPS_BY_WORKFLOW: Partial<Record<CrmSlug, Record<string, Record<string, Array<{ fieldId: string; hubspotProperty: string }>>>>> = {
  hubspot: HUBSPOT_FIELD_MAPS_BY_WORKFLOW,
};
const CRM_PROSPECT_FIELD_MAPPINGS: Partial<Record<CrmSlug, Record<string, Array<{ saleshandyFieldName: string; hubspotProperty: string; testValue: string }>>>> = {
  hubspot: HUBSPOT_PROSPECT_FIELD_MAPPINGS,
};
const CRM_VERIFIER_FACTORIES: Partial<Record<CrmSlug, (action: string) => ReturnType<typeof createHubspotVerifierForAction>>> = {
  hubspot: createHubspotVerifierForAction,
};

async function main(): Promise<void> {
  assertRefoldTestEnvironment(requireEnv('REFOLD_API_KEY'));

  const args = process.argv.slice(2);
  const resume = args.includes('--resume');
  const configPath = args.find((a) => !a.startsWith('--')) ?? 'harness.config.json';
  const harnessConfig = await loadHarnessConfig(configPath);

  const saleshandy = new SaleshandyClient({ baseUrl: requireEnv('SALESHANDY_BASE_URL'), apiKey: requireEnv('SALESHANDY_API_TOKEN') });
  const senderEmail = requireEnv('SALESHANDY_SENDER_EMAIL');
  const baseEmail = requireEnv('SALESHANDY_TEST_PROSPECT_BASE_EMAIL');
  const mailbox = new TestMailboxClient({
    imapHost: requireEnv('TEST_MAILBOX_IMAP_HOST'),
    imapPort: Number(requireEnv('TEST_MAILBOX_IMAP_PORT')),
    smtpHost: requireEnv('TEST_MAILBOX_SMTP_HOST'),
    smtpPort: Number(requireEnv('TEST_MAILBOX_SMTP_PORT')),
    username: requireEnv('TEST_MAILBOX_USERNAME'),
    password: requireEnv('TEST_MAILBOX_APP_PASSWORD'),
  });
  const edgeSessionToken = optionalEnv('SALESHANDY_EDGE_SESSION_TOKEN');
  const edge = edgeSessionToken
    ? new SaleshandyEdgeClient({ baseUrl: requireEnv('SALESHANDY_EDGE_BASE_URL'), sessionToken: edgeSessionToken })
    : undefined;

  // A fresh (non --resume) run means "start clean" — wipe every leftover
  // SalesHandy sequence and HubSpot object from previous runs first, so
  // this run's checks can't accidentally pass/fail against stale data.
  // Never do this on --resume: that continues an EARLIER run's real
  // objects on purpose (e.g. testing "update" against what "create" made).
  if (!resume) {
    console.log('\nCleaning up leftover test data (SalesHandy sequences + HubSpot objects) before a fresh run...');
    await cleanupPreviousTestData({ edge });
  }

  const rows: SuiteReportRow[] = [];

  // Minted lazily — only if some spec in this invocation actually starts a
  // FRESH context (a pure --resume invocation reuses each spec's own
  // already-saved number instead of wasting a new one). Shared across every
  // spec processed in this invocation, so they all land under one
  // top-level test-results/<runNumber>/ folder — see getNextRunNumber.
  let sharedRunNumber: number | undefined;
  async function getSharedRunNumber(): Promise<string> {
    sharedRunNumber ??= await getNextRunNumber();
    return String(sharedRunNumber);
  }

  for (const [crm, workflowSpecs] of Object.entries(harnessConfig.workflows) as Array<
    [CrmSlug, typeof harnessConfig.workflows[CrmSlug]]
  >) {
    const buildVerifier = CRM_VERIFIER_FACTORIES[crm];
    if (!buildVerifier) continue;

    const configId = requireEnv(`REFOLD_${crm.toUpperCase()}_LINKED_ACCOUNT_ID`);
    const refold = new RefoldClient({ baseUrl: requireEnv('REFOLD_BASE_URL'), linkedAccountId: configId, apiKey: requireEnv('REFOLD_API_KEY') });

    for (const spec of workflowSpecs ?? []) {
      if (spec.active === false) {
        console.log(`\nSkipping ${crm}/${spec.workflowId} — marked inactive in harness config (set "active": true to re-enable).`);
        continue;
      }

      const phases = spec.phases;
      if (!phases || phases.length === 0) continue;

      const fieldMaps = CRM_FIELD_MAPS_BY_WORKFLOW[crm]?.[spec.workflowId];
      if (!fieldMaps) {
        console.log(`\nSkipping ${crm}/${spec.workflowId} — no field map registered. Add one to field-map-registry.ts.`);
        continue;
      }

      // Distinguishes this spec's saved context from any OTHER spec
      // targeting the same Refold workflowId (e.g. a same-outcome chain vs.
      // a diff-outcome chain both testing "Prospect Outcome is updated") —
      // see HarnessWorkflowSpec.contextKey's docstring.
      const contextKey = spec.contextKey ?? spec.workflowId;

      console.log(`\n########## Phased run on ${crm} / ${spec.workflowId} (key: ${contextKey}, ${phases.length} phase(s)) ##########`);

      // One prospect/sequence for the whole workflow — every phase reuses
      // it. With --resume, reuse a PREVIOUS run's context instead of
      // generating a fresh prospect, so a later phase acts on the same
      // real objects an earlier phase already made (see this file's
      // top-of-file docstring).
      let context: RunContext;
      let sequenceSetUp: boolean;
      if (resume) {
        // eslint-disable-next-line no-await-in-loop
        context = await loadRunContext(crm, contextKey);
        sequenceSetUp = true;
        console.log(`Resumed context for ${crm}/${contextKey} — prospect ${context.prospectEmail}`);
      } else {
        const runId = generateRunId(`${crm}-phases`);
        context = {
          runId,
          prospectEmail: buildProspectEmail(baseEmail, generateShortToken()),
          testCase: { id: runId, crm, workflowId: spec.workflowId, workflowName: spec.workflowId, action: 'phased', expectedFields: {} },
        };
        sequenceSetUp = false;
      }
      // One run number for the WHOLE suite run, shared across every phase —
      // including phases run in a later --resume invocation, since it's
      // carried inside the persisted context. See RunContext.reportTimestamp
      // and getNextRunNumber — a plain incrementing integer, not a
      // timestamp, despite the field's name.
      // eslint-disable-next-line no-await-in-loop
      context.reportTimestamp ??= await getSharedRunNumber();
      const reportTimestamp = context.reportTimestamp;

      // Prospect-data field mappings (LinkedIn/Twitter/etc., see
      // prospect-field-mappings.ts) must be SET ON THE PROSPECT during
      // setup, or the corresponding expected values will never appear in
      // Refold's resolved payload. Setup only runs once per workflow (not
      // per phase), so this has to cover every phase's actions up front —
      // not just whichever phase happens to trigger setup.
      const extraProspectFields = Object.fromEntries(
        phases.flatMap((p) =>
          p.actions.flatMap((action) => (CRM_PROSPECT_FIELD_MAPPINGS[crm]?.[action] ?? []).map((m) => [m.saleshandyFieldName, m.testValue])),
        ),
      );

      for (let phaseIndex = 0; phaseIndex < phases.length; phaseIndex++) {
        const phase = phases[phaseIndex]!;
        console.log(`\n=== Phase "${phase.name}" (${phase.actions.length} action(s)) ===`);

        // --- Preflight every action in this phase, all at once ---
        // This script is meant to be run unattended (no interactive
        // terminal on the other end) — if a phase isn't ready, it records
        // WHY and moves on immediately rather than blocking on a keypress
        // that will never come. Fix the dashboard and re-run the suite.
        const outcomeGateFields = crm === 'hubspot' ? HUBSPOT_OUTCOME_GATE_FIELDS_BY_WORKFLOW[spec.workflowId] : undefined;
        // eslint-disable-next-line no-await-in-loop
        const preflights = await Promise.all(
          phase.actions.map((action) =>
            preflightWorkflowAction({
              refold,
              slug: crm,
              configId,
              workflowId: spec.workflowId,
              actionCode: action,
              fieldMap: fieldMaps[action] ?? [],
              outcomeGateFieldId: outcomeGateFields?.[action],
            }),
          ),
        );

        const missing = phase.actions.filter((_, i) => !preflights[i]!.ok);
        if (missing.length > 0) {
          const priorPhase = phaseIndex > 0 ? phases[phaseIndex - 1] : undefined;
          console.log(
            `Skipping phase "${phase.name}" — not all actions selected on the dashboard yet.\n` +
              `Needs ALL of: ${phase.actions.join(', ')}\n` +
              `Not ready: ${missing.join(', ')}\n` +
              (priorPhase ? `(Disable phase "${priorPhase.name}"'s actions first: ${priorPhase.actions.join(', ')})` : ''),
          );
          const phaseRows: SuiteReportRow[] = phase.actions.map((action, i) => {
            const p = preflights[i]!;
            return {
              crm,
              workflowId: spec.workflowId,
              workflowName: p.workflowName ?? spec.workflowId,
              action,
              status: 'SKIPPED' as const,
              reason: p.ok ? `Phase "${phase.name}" aborted — other actions in this phase were not ready.` : p.reason,
            };
          });
          rows.push(...phaseRows);
          // eslint-disable-next-line no-await-in-loop
          const mdPath = await writeWorkflowReport({
            runNumber: reportTimestamp,
            workflowId: spec.workflowId,
            rows: rows.filter((r) => r.workflowId === spec.workflowId),
          });
          console.log(`Report updated: ${mdPath}`);
          continue;
        }

        const workflowName = preflights[0]!.workflowName ?? spec.workflowId;
        const mode = phase.mode ?? 'same-outcome';

        // expectFire[i] says whether action i is expected to actually fire
        // from this phase's trigger. For 'same-outcome', always true (and
        // every action must share one outcome, or we can't trigger them
        // together at all). For 'diff-outcome', actions are DELIBERATELY
        // gated to different outcomes — only whichever one matches the
        // single outcome we actually fire should expect to fire. See
        // execution-plan.md §26.
        let triggerOutcome: string | undefined;
        let expectFire: boolean[];

        if (mode === 'same-outcome') {
          const configuredOutcomes = [...new Set(preflights.map((p) => p.configuredOutcome).filter((o): o is string => o !== undefined))];
          if (configuredOutcomes.length > 1) {
            const mismatchDetail = phase.actions
              .map((action, i) => `${action}=${preflights[i]!.configuredOutcome ?? '(none)'}`)
              .join(', ');
            console.log(`Skipping phase "${phase.name}" — actions are gated to different outcomes: ${mismatchDetail}`);
            const phaseRows: SuiteReportRow[] = phase.actions.map((action, i) => ({
              crm,
              workflowId: spec.workflowId,
              workflowName,
              action,
              status: 'SKIPPED' as const,
              reason: `Gated to outcome "${preflights[i]!.configuredOutcome ?? '(none)'}" — other actions in this phase use a different outcome (${mismatchDetail}). Set them all to the same outcome in the dashboard, or use mode: "diff-outcome" if that's intentional.`,
            }));
            rows.push(...phaseRows);
            // eslint-disable-next-line no-await-in-loop
            await writeWorkflowReport({
              runNumber: reportTimestamp,
              workflowId: spec.workflowId,
              rows: rows.filter((r) => r.workflowId === spec.workflowId),
            });
            continue;
          }
          triggerOutcome = configuredOutcomes[0];
          expectFire = phase.actions.map(() => true);
        } else {
          // 'diff-outcome': anchor on create-contact/update-contact's own
          // configured outcome unless explicitly overridden — everything
          // else (deal/company/task associations) resolves through that
          // contact, so it has to actually get created/updated.
          const contactIndex = phase.actions.findIndex((a) => a === 'create-contact' || a === 'update-contact');
          triggerOutcome = phase.triggerOutcome ?? (contactIndex >= 0 ? preflights[contactIndex]!.configuredOutcome : undefined);
          if (!triggerOutcome) {
            const reason =
              `Phase "${phase.name}" is mode: "diff-outcome" but no triggerOutcome is set and no create-contact/` +
              `update-contact action with a configured outcome was found to use as the anchor.`;
            console.log(`Skipping phase "${phase.name}" — ${reason}`);
            const phaseRows: SuiteReportRow[] = phase.actions.map((action, i) => ({
              crm,
              workflowId: spec.workflowId,
              workflowName,
              action,
              status: 'SKIPPED' as const,
              reason,
            }));
            rows.push(...phaseRows);
            // eslint-disable-next-line no-await-in-loop
            await writeWorkflowReport({
              runNumber: reportTimestamp,
              workflowId: spec.workflowId,
              rows: rows.filter((r) => r.workflowId === spec.workflowId),
            });
            continue;
          }

          expectFire = preflights.map((p) => p.configuredOutcome === undefined || p.configuredOutcome === triggerOutcome);
          const distinctOutcomes = [...new Set(preflights.map((p) => p.configuredOutcome).filter((o): o is string => o !== undefined))];
          if (distinctOutcomes.length <= 1) {
            console.log(
              `WARNING: phase "${phase.name}" is mode: "diff-outcome" but every gated action shares the same outcome ` +
                `(${distinctOutcomes[0] ?? '(none)'}) — this won't actually exercise the gating difference. Configure ` +
                `at least one action with a different "Select Outcome" value.`,
            );
          }
        }

        // --- Trigger: set up once, then trigger once per phase (reply or
        // direct outcome-update API call, depending on the workflow — see
        // outcome-gate-registry.ts's TriggerType) ---
        if (!sequenceSetUp) {
          // eslint-disable-next-line no-await-in-loop
          await setupSaleshandySequence({ saleshandy, senderEmail, context, extraProspectFields, edge });
          if (edge) {
            // eslint-disable-next-line no-await-in-loop
            await ensurePromptSend({ edge, context });
          }
          sequenceSetUp = true;
          // Persist NOW, before the reply/verify below — so a later
          // --resume invocation can pick this prospect up even if this
          // phase's own verification fails or the process is interrupted.
          // eslint-disable-next-line no-await-in-loop
          await saveRunContext(crm, contextKey, context);
        } else {
          console.log(`Triggering phase "${phase.name}" a second time on the same prospect...`);
        }

        const triggerType = getTriggerType(spec.workflowId);
        if (triggerType === 'outcome') {
          if (!triggerOutcome) {
            throw new Error(`Workflow ${spec.workflowId} is outcome-gated but no trigger outcome could be resolved for phase "${phase.name}".`);
          }
          if (!edge) {
            throw new Error(
              `Workflow ${spec.workflowId} is outcome-gated and needs the edge API to trigger it (SALESHANDY_EDGE_SESSION_TOKEN / SALESHANDY_EDGE_BASE_URL) — the public Open API path is confirmed broken (SH-20244).`,
            );
          }
          // eslint-disable-next-line no-await-in-loop
          await triggerOutcomeUpdate({ edge, context, outcomeName: triggerOutcome });
        } else if (triggerType === 'unsubscribe') {
          if (!edge) {
            throw new Error(`Workflow ${spec.workflowId} is triggered via the edge API unsubscribe endpoint (SALESHANDY_EDGE_SESSION_TOKEN / SALESHANDY_EDGE_BASE_URL required).`);
          }
          // eslint-disable-next-line no-await-in-loop
          await triggerUnsubscribe({ edge, context });
        } else if (triggerType === 'bounce') {
          if (!edge) {
            throw new Error(`Workflow ${spec.workflowId} is triggered via the edge API mark-as-bounced endpoint (SALESHANDY_EDGE_SESSION_TOKEN / SALESHANDY_EDGE_BASE_URL required).`);
          }
          // eslint-disable-next-line no-await-in-loop
          await triggerBounce({ edge, context });
        } else if (triggerType === 'click') {
          if (!edge) {
            throw new Error(`Workflow ${spec.workflowId} is triggered by clicking a real tracked link (SALESHANDY_EDGE_SESSION_TOKEN / SALESHANDY_EDGE_BASE_URL required for the force-send step).`);
          }
          // eslint-disable-next-line no-await-in-loop
          await triggerLinkClick({ edge, mailbox, context });
        } else {
          // eslint-disable-next-line no-await-in-loop
          await autoReply({ mailbox, senderEmail, context });
        }

        // --- Verify: one execution, one node per action ---
        const actionSpecs = phase.actions.map((action, i) => {
          const prospectMappings = CRM_PROSPECT_FIELD_MAPPINGS[crm]?.[action] ?? [];
          const mappedExpectedFields = Object.fromEntries(prospectMappings.map((m) => [m.hubspotProperty, m.testValue]));
          return {
            action,
            expectedFields: { ...preflights[i]!.expectedFields!, ...mappedExpectedFields },
            verifier: buildVerifier(action),
            expectFire: expectFire[i],
          };
        });

        let phaseRows: SuiteReportRow[];
        try {
          // eslint-disable-next-line no-await-in-loop
          const { executionId, results } = await verifyMultiActionExecution({
            prospectEmail: context.prospectEmail,
            workflowId: spec.workflowId,
            workflowName,
            since: new Date(context.triggeredAt!),
            refold,
            actions: actionSpecs,
          });

          phaseRows = results.map((result) => {
            const rawDetail = [...result.refold.mismatches, ...result.crm.mismatches]
              .map((m) => `${m.field}: expected ${JSON.stringify(m.expected)}, got ${JSON.stringify(m.actual)}`)
              .join('; ');
            const reason = result.pass
              ? undefined
              : result.expectFire
                ? rawDetail
                : `Expected this action NOT to fire (outcome gate didn't match "${triggerOutcome}"), but it did — ${rawDetail}`;
            return {
              crm,
              workflowId: spec.workflowId,
              workflowName,
              action: result.action,
              status: result.pass ? ('PASS' as const) : ('FAIL' as const),
              reason,
              expectFire: result.expectFire,
              evidence: {
                refoldExecutionId: executionId,
                crmObjectId: (result.crm.raw as { id?: string } | undefined)?.id,
              },
            };
          });
        } catch (error) {
          const message = (error as Error).message ?? String(error);
          phaseRows = phase.actions.map((action) => ({
            crm,
            workflowId: spec.workflowId,
            workflowName,
            action,
            status: 'FAIL' as const,
            reason: message,
          }));
        }
        rows.push(...phaseRows);

        // Persist as soon as this phase finishes — don't wait until every
        // phase is done, so a crash/interrupt in a LATER phase never loses
        // an EARLIER phase's results. One combined report.md (every action,
        // every phase so far) + result.json per workflow, under
        // test-results/<runNumber>/<workflowId>/ — see writeWorkflowReport.
        // eslint-disable-next-line no-await-in-loop
        const mdPath = await writeWorkflowReport({
          runNumber: reportTimestamp,
          workflowId: spec.workflowId,
          rows: rows.filter((r) => r.workflowId === spec.workflowId),
        });
        console.log(`Report updated: ${mdPath}`);
      }
    }
  }

  printSuiteReport(rows);
  process.exit(rows.some((r) => r.status === 'FAIL') ? 1 : 0);
}

main().catch((error) => {
  console.error('Fatal error:', error.response?.data ?? error.message ?? error);
  process.exit(1);
});
