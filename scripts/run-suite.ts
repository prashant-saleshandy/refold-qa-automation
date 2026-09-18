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
 * Usage: npx tsx scripts/run-suite.ts [path/to/harness.config.json]
 */
import 'dotenv/config';
import { TestMailboxClient } from '../src/clients/mailbox/test-mailbox-client.js';
import { RefoldClient } from '../src/clients/refold/refold-client.js';
import { SaleshandyEdgeClient } from '../src/clients/saleshandy/saleshandy-edge-client.js';
import { SaleshandyClient } from '../src/clients/saleshandy/saleshandy-client.js';
import { optionalEnv, requireEnv } from '../src/config/env.js';
import { assertRefoldTestEnvironment } from '../src/config/safety-guard.js';
import { buildProspectEmail, generateRunId, generateShortToken } from '../src/core/correlation.js';
import { loadHarnessConfig } from '../src/core/harness-config.js';
import { preflightWorkflowAction } from '../src/core/preflight.js';
import { printSuiteReport, writeSuiteReport } from '../src/core/report.js';
import { waitForEnter } from '../src/core/prompt.js';
import { autoReply, ensurePromptSend, setupSaleshandySequence, verifyMultiActionExecution } from '../src/core/test-runner.js';
import type { CrmSlug, RunContext, SuiteReportRow } from '../src/core/types.js';
import { HUBSPOT_ACTION_FIELD_MAP } from '../src/workflows/hubspot/field-map.js';
import { HUBSPOT_PROSPECT_FIELD_MAPPINGS } from '../src/workflows/hubspot/prospect-field-mappings.js';
import { createHubspotVerifierForAction } from '../src/workflows/hubspot/verifier.js';

// Only HubSpot is wired up today — see execution-plan.md §8 for rollout order.
const CRM_FIELD_MAPS: Partial<Record<CrmSlug, Record<string, Array<{ fieldId: string; hubspotProperty: string }>>>> = {
  hubspot: HUBSPOT_ACTION_FIELD_MAP,
};
const CRM_PROSPECT_FIELD_MAPPINGS: Partial<Record<CrmSlug, Record<string, Array<{ saleshandyFieldName: string; hubspotProperty: string; testValue: string }>>>> = {
  hubspot: HUBSPOT_PROSPECT_FIELD_MAPPINGS,
};
const CRM_VERIFIER_FACTORIES: Partial<Record<CrmSlug, (action: string) => ReturnType<typeof createHubspotVerifierForAction>>> = {
  hubspot: createHubspotVerifierForAction,
};

async function main(): Promise<void> {
  assertRefoldTestEnvironment(requireEnv('REFOLD_API_KEY'));

  const configPath = process.argv[2] ?? 'harness.config.json';
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

  const rows: SuiteReportRow[] = [];

  for (const [crm, workflowSpecs] of Object.entries(harnessConfig.workflows) as Array<
    [CrmSlug, typeof harnessConfig.workflows[CrmSlug]]
  >) {
    const fieldMaps = CRM_FIELD_MAPS[crm];
    const buildVerifier = CRM_VERIFIER_FACTORIES[crm];
    if (!fieldMaps || !buildVerifier) continue;

    const configId = requireEnv(`REFOLD_${crm.toUpperCase()}_LINKED_ACCOUNT_ID`);
    const refold = new RefoldClient({ baseUrl: requireEnv('REFOLD_BASE_URL'), linkedAccountId: configId, apiKey: requireEnv('REFOLD_API_KEY') });

    for (const spec of workflowSpecs ?? []) {
      const phases = spec.phases;
      if (!phases || phases.length === 0) continue;

      console.log(`\n########## Phased run on ${crm} / ${spec.workflowId} (${phases.length} phase(s)) ##########`);

      // One prospect/sequence for the whole workflow — every phase reuses it.
      const runId = generateRunId(`${crm}-phases`);
      const context: RunContext = {
        runId,
        prospectEmail: buildProspectEmail(baseEmail, generateShortToken()),
        testCase: { id: runId, crm, workflowId: spec.workflowId, workflowName: spec.workflowId, action: 'phased', expectedFields: {} },
      };

      let sequenceSetUp = false;

      for (let phaseIndex = 0; phaseIndex < phases.length; phaseIndex++) {
        const phase = phases[phaseIndex]!;
        console.log(`\n=== Phase "${phase.name}" (${phase.actions.length} action(s)) ===`);

        // --- Preflight every action in this phase, all at once ---
        // eslint-disable-next-line no-await-in-loop
        let preflights = await Promise.all(
          phase.actions.map((action) =>
            preflightWorkflowAction({ refold, slug: crm, configId, workflowId: spec.workflowId, actionCode: action, fieldMap: fieldMaps[action] ?? [] }),
          ),
        );

        if (preflights.some((p) => !p.ok)) {
          const missing = phase.actions.filter((_, i) => !preflights[i]!.ok);
          const priorPhase = phaseIndex > 0 ? phases[phaseIndex - 1] : undefined;
          // eslint-disable-next-line no-await-in-loop
          await waitForEnter(
            `Phase "${phase.name}" needs ALL of these selected simultaneously on the dashboard:\n` +
              phase.actions.map((a) => `  - ${a}`).join('\n') +
              `\n\nNot ready yet: ${missing.join(', ')}\n` +
              (priorPhase ? `(Disable phase "${priorPhase.name}"'s actions first: ${priorPhase.actions.join(', ')})\n` : ''),
          );
          // eslint-disable-next-line no-await-in-loop
          preflights = await Promise.all(
            phase.actions.map((action) =>
              preflightWorkflowAction({ refold, slug: crm, configId, workflowId: spec.workflowId, actionCode: action, fieldMap: fieldMaps[action] ?? [] }),
            ),
          );
        }

        const stillMissing = phase.actions.filter((_, i) => !preflights[i]!.ok);
        if (stillMissing.length > 0) {
          for (let i = 0; i < phase.actions.length; i++) {
            const action = phase.actions[i]!;
            const p = preflights[i]!;
            rows.push({
              crm,
              workflowId: spec.workflowId,
              workflowName: p.workflowName ?? spec.workflowId,
              action,
              status: 'SKIPPED',
              reason: p.ok ? `Phase "${phase.name}" aborted — other actions in this phase were not ready.` : p.reason,
            });
          }
          console.log(`Skipping phase "${phase.name}" — not all actions were selected.`);
          // eslint-disable-next-line no-await-in-loop
          const skippedPath = await writeSuiteReport(rows, `${crm}-${spec.workflowId}-${phase.name}`);
          console.log(`Phase "${phase.name}" results (skipped) saved to ${skippedPath}`);
          continue;
        }

        const workflowName = preflights[0]!.workflowName ?? spec.workflowId;

        // --- Trigger: set up once, reply once per phase ---
        if (!sequenceSetUp) {
          // eslint-disable-next-line no-await-in-loop
          await setupSaleshandySequence({ saleshandy, senderEmail, context });
          if (edge) {
            // eslint-disable-next-line no-await-in-loop
            await ensurePromptSend({ edge, context });
          }
          sequenceSetUp = true;
        } else {
          console.log(`Sending a second reply on the same thread to trigger phase "${phase.name}"...`);
        }
        // eslint-disable-next-line no-await-in-loop
        await autoReply({ mailbox, senderEmail, context });

        // --- Verify: one execution, one node per action ---
        const actionSpecs = phase.actions.map((action, i) => {
          const prospectMappings = CRM_PROSPECT_FIELD_MAPPINGS[crm]?.[action] ?? [];
          const mappedExpectedFields = Object.fromEntries(prospectMappings.map((m) => [m.hubspotProperty, m.testValue]));
          return {
            action,
            expectedFields: { ...preflights[i]!.expectedFields!, ...mappedExpectedFields },
            verifier: buildVerifier(action),
          };
        });

        try {
          // eslint-disable-next-line no-await-in-loop
          const { executionId, results } = await verifyMultiActionExecution({
            prospectEmail: context.prospectEmail,
            workflowId: spec.workflowId,
            workflowName,
            since: new Date(context.repliedAt!),
            refold,
            actions: actionSpecs,
          });

          for (const result of results) {
            rows.push({
              crm,
              workflowId: spec.workflowId,
              workflowName,
              action: result.action,
              status: result.pass ? 'PASS' : 'FAIL',
              reason: result.pass
                ? undefined
                : [...result.refold.mismatches, ...result.crm.mismatches]
                    .map((m) => `${m.field}: expected ${JSON.stringify(m.expected)}, got ${JSON.stringify(m.actual)}`)
                    .join('; '),
              evidence: { refoldExecutionId: executionId },
            });
          }
        } catch (error) {
          const message = (error as Error).message ?? String(error);
          for (const action of phase.actions) {
            rows.push({ crm, workflowId: spec.workflowId, workflowName, action, status: 'FAIL', reason: message });
          }
        }

        // Persist a snapshot as soon as this phase finishes — don't wait
        // until every phase is done, so a crash/interrupt in a LATER phase
        // never loses an EARLIER phase's results. Every call gets its own
        // fresh timestamped file (see writeSuiteReport) — nothing is ever
        // overwritten or deleted, across phases or across separate runs.
        // eslint-disable-next-line no-await-in-loop
        const phasePath = await writeSuiteReport(rows, `${crm}-${spec.workflowId}-${phase.name}`);
        console.log(`Phase "${phase.name}" results saved to ${phasePath}`);
      }
    }
  }

  printSuiteReport(rows);
  const reportPath = await writeSuiteReport(rows, 'final');
  console.log(`\nFinal combined report (all phases) written to ${reportPath}`);
  process.exit(rows.some((r) => r.status === 'FAIL') ? 1 : 0);
}

main().catch((error) => {
  console.error('Fatal error:', error.response?.data ?? error.message ?? error);
  process.exit(1);
});
