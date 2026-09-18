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
import { RefoldClient } from '../src/clients/refold/refold-client.js';
import { requireEnv } from '../src/config/env.js';
import { assertRefoldTestEnvironment } from '../src/config/safety-guard.js';
import { loadHarnessConfig } from '../src/core/harness-config.js';
import { preflightWorkflowAction } from '../src/core/preflight.js';
import type { CrmSlug } from '../src/core/types.js';
import { HUBSPOT_ACTION_FIELD_MAP } from '../src/workflows/hubspot/field-map.js';

const CRM_FIELD_MAPS: Partial<Record<CrmSlug, Record<string, Array<{ fieldId: string; hubspotProperty: string }>>>> = {
  hubspot: HUBSPOT_ACTION_FIELD_MAP,
};

async function main(): Promise<void> {
  assertRefoldTestEnvironment(requireEnv('REFOLD_API_KEY'));

  const configPath = process.argv[2] ?? 'harness.config.json';
  const harnessConfig = await loadHarnessConfig(configPath);

  for (const [crm, workflowSpecs] of Object.entries(harnessConfig.workflows) as Array<
    [CrmSlug, typeof harnessConfig.workflows[CrmSlug]]
  >) {
    const fieldMaps = CRM_FIELD_MAPS[crm];
    if (!fieldMaps) {
      for (const spec of workflowSpecs ?? []) {
        for (const phase of spec.phases ?? []) {
          for (const action of phase.actions) {
            console.log(`[NOT WIRED UP] ${crm} / ${spec.workflowId} / phase "${phase.name}" / ${action}`);
          }
        }
      }
      continue;
    }

    const configId = requireEnv(`REFOLD_${crm.toUpperCase()}_LINKED_ACCOUNT_ID`);
    const refold = new RefoldClient({
      baseUrl: requireEnv('REFOLD_BASE_URL'),
      linkedAccountId: configId,
      apiKey: requireEnv('REFOLD_API_KEY'),
    });

    for (const spec of workflowSpecs ?? []) {
      console.log(`\n=== ${crm} / ${spec.workflowId} ===`);

      for (const phase of spec.phases ?? []) {
        console.log(`\n  --- phase "${phase.name}" (needs ALL of these selected simultaneously) ---`);
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
          });

          console.log(
            preflight.ok
              ? `    [READY] ${action} — expected fields: ${JSON.stringify(preflight.expectedFields)}`
              : `    [NOT READY] ${action} — ${preflight.reason}`,
          );
        }
      }
    }
  }
}

main().catch((error) => {
  console.error('Fatal error:', error.response?.data ?? error.message ?? error);
  process.exit(1);
});
