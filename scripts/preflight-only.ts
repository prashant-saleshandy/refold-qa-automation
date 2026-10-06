/**
 * Read-only readiness check: runs preflightWorkflowAction() for every action
 * in every phase declared in harness.config.json, WITHOUT running any actual
 * test (no SalesHandy sequence, no email, no CRM writes). Use this to answer
 * "are we ready to run the suite?" before spending time/mailbox-quota on a
 * phase that would just get skipped anyway because not all of its actions
 * are selected on the dashboard yet.
 *
 * Usage: npx tsx scripts/preflight-only.ts [path/to/harness.config.json]
 */
import 'dotenv/config';
import dns from 'node:dns';
import net from 'node:net';
import { RefoldClient } from '../src/clients/refold/refold-client.js';

// See scripts/run-suite.ts's identical block for why: Node's Happy Eyeballs
// dual-stack connection racing intermittently times out in this environment
// even on IPv4 addresses a plain curl reaches instantly — disabling it forces
// sequential single-address connects instead.
net.setDefaultAutoSelectFamily(false);
dns.setDefaultResultOrder('ipv4first');
import { requireEnv } from '../src/config/env.js';
import { assertRefoldTestEnvironment } from '../src/config/safety-guard.js';
import { loadHarnessConfig } from '../src/core/harness-config.js';
import { preflightWorkflowAction } from '../src/core/preflight.js';
import type { CrmSlug } from '../src/core/types.js';
import { HUBSPOT_FIELD_MAPS_BY_WORKFLOW } from '../src/workflows/hubspot/field-map-registry.js';
import { HUBSPOT_OUTCOME_GATE_FIELDS_BY_WORKFLOW } from '../src/workflows/hubspot/outcome-gate-registry.js';

// Field maps are keyed by workflowId first — see field-map-registry.ts.
const CRM_FIELD_MAPS_BY_WORKFLOW: Partial<Record<CrmSlug, Record<string, Record<string, Array<{ fieldId: string; hubspotProperty: string }>>>>> = {
  hubspot: HUBSPOT_FIELD_MAPS_BY_WORKFLOW,
};

async function main(): Promise<void> {
  assertRefoldTestEnvironment(requireEnv('REFOLD_API_KEY'));

  const configPath = process.argv[2] ?? 'harness.config.json';
  const harnessConfig = await loadHarnessConfig(configPath);

  for (const [crm, workflowSpecs] of Object.entries(harnessConfig.workflows) as Array<
    [CrmSlug, typeof harnessConfig.workflows[CrmSlug]]
  >) {
    const configId = requireEnv(`REFOLD_${crm.toUpperCase()}_LINKED_ACCOUNT_ID`);
    const refold = new RefoldClient({
      baseUrl: requireEnv('REFOLD_BASE_URL'),
      linkedAccountId: configId,
      apiKey: requireEnv('REFOLD_API_KEY'),
    });

    for (const spec of workflowSpecs ?? []) {
      if (spec.active === false) {
        console.log(`\n=== ${crm} / ${spec.workflowId} === [INACTIVE — set "active": true in harness.config.json to re-enable]`);
        continue;
      }

      const contextKey = spec.contextKey ?? spec.workflowId;
      console.log(`\n=== ${crm} / ${spec.workflowId} (key: ${contextKey}) ===`);

      const fieldMaps = CRM_FIELD_MAPS_BY_WORKFLOW[crm]?.[spec.workflowId];
      if (!fieldMaps) {
        for (const phase of spec.phases ?? []) {
          for (const action of phase.actions) {
            console.log(`  [NOT WIRED UP] phase "${phase.name}" / ${action} — no field map registered for this workflow`);
          }
        }
        continue;
      }

      const outcomeGateFields = crm === 'hubspot' ? HUBSPOT_OUTCOME_GATE_FIELDS_BY_WORKFLOW[spec.workflowId] : undefined;

      for (const phase of spec.phases ?? []) {
        const mode = phase.mode ?? 'same-outcome';
        console.log(`\n  --- phase "${phase.name}" [mode: ${mode}] (needs ALL of these selected simultaneously) ---`);
        const phaseOutcomes: Array<{ action: string; outcome: string }> = [];
        for (const action of phase.actions) {
          const fieldMap = fieldMaps[action];
          if (!fieldMap) {
            console.log(`    [NO FIELD MAP] ${action} — add one to src/workflows/${crm}/field-map.ts`);
            continue;
          }

          // eslint-disable-next-line no-await-in-loop
          const preflight = await preflightWorkflowAction({
            refold,
            slug: crm,
            configId,
            workflowId: spec.workflowId,
            actionCode: action,
            fieldMap,
            outcomeGateFieldId: outcomeGateFields?.[action],
          });

          const outcomeNote = preflight.configuredOutcome ? ` — gated to outcome "${preflight.configuredOutcome}"` : '';
          if (preflight.configuredOutcome) phaseOutcomes.push({ action, outcome: preflight.configuredOutcome });
          console.log(
            preflight.ok
              ? `    [READY] ${action} — expected fields: ${JSON.stringify(preflight.expectedFields)}${outcomeNote}`
              : `    [NOT READY] ${action} — ${preflight.reason}`,
          );
        }

        const distinctOutcomes = [...new Set(phaseOutcomes.map((p) => p.outcome))];
        if (mode === 'same-outcome' && distinctOutcomes.length > 1) {
          console.log(
            `    [WARNING] Actions in this phase are gated to DIFFERENT outcomes (${distinctOutcomes.join(', ')}) — ` +
              `one trigger call can't fire all of them. Set them all to the same outcome, or use mode: "diff-outcome" if that's intentional.`,
          );
        } else if (mode === 'diff-outcome') {
          const contactEntry = phaseOutcomes.find((p) => p.action === 'create-contact' || p.action === 'update-contact');
          const resolvedTrigger = phase.triggerOutcome ?? contactEntry?.outcome;
          if (!resolvedTrigger) {
            console.log(`    [NOT READY] diff-outcome phase needs an explicit triggerOutcome or a create-contact/update-contact action with a configured outcome.`);
          } else {
            console.log(`    Trigger outcome would be: "${resolvedTrigger}"`);
            for (const action of phase.actions) {
              const entry = phaseOutcomes.find((p) => p.action === action);
              const willFire = entry === undefined || entry.outcome === resolvedTrigger;
              console.log(`      ${action}: expected to ${willFire ? 'FIRE' : 'NOT fire'}${entry ? ` (gated to "${entry.outcome}")` : ' (no gate)'}`);
            }
            if (distinctOutcomes.length <= 1) {
              console.log(`    [WARNING] Every gated action shares the same outcome — this phase won't actually exercise a gating difference yet.`);
            }
          }
        }
      }
    }
  }
}

main().catch((error) => {
  console.error('Fatal error:', error.response?.data ?? error.message ?? error);
  process.exit(1);
});
