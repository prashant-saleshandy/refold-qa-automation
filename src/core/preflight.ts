import type { RefoldClient, RefoldConfigWorkflow } from '../clients/refold/refold-client.js';

export interface PreflightResult {
  ok: boolean;
  /** Present whenever the workflow itself was found, pass or fail — used
   * for report labeling even on a SKIPPED row. */
  workflowName?: string;
  /** Present when ok is false — the exact fix needed, shown in the report. */
  reason?: string;
  /** Present when ok is true — resolved from the LIVE config's current
   * field values, not hardcoded, so the harness always tests whatever is
   * actually configured right now. */
  expectedFields?: Record<string, unknown>;
}

const ACTION_FIELD_NAME_PATTERN = /action\d+$/i;

/**
 * Confirms a workflow is actually enabled and the given action is actually
 * selected before spending time running a full test against it — see
 * execution-plan.md §11. This is what replaces the "automate enabling the
 * workflow" idea we ruled out (too heavy/unreliable, see §10) with a safe
 * fail-fast check instead.
 */
export async function preflightWorkflowAction(params: {
  refold: RefoldClient;
  slug: string;
  configId: string;
  workflowId: string;
  actionCode: string;
  fieldMap: Array<{ fieldId: string; hubspotProperty: string }>;
}): Promise<PreflightResult> {
  const { refold, slug, configId, workflowId, actionCode, fieldMap } = params;

  const config = await refold.getConfig(slug, configId);
  const workflow = config.workflows.find((w) => w.id === workflowId);
  if (!workflow) {
    return { ok: false, reason: `Workflow ${workflowId} not found in ${slug} config ${configId}.` };
  }

  if (!workflow.enabled) {
    return {
      ok: false,
      workflowName: workflow.name,
      reason: `Workflow "${workflow.name}" is disabled — enable it in the dashboard before testing.`,
    };
  }

  if (!isActionConfigured(workflow, actionCode)) {
    return {
      ok: false,
      workflowName: workflow.name,
      reason:
        `Action "${actionCode}" is not selected on any ActionN field of "${workflow.name}" — ` +
        `select it in the dashboard before testing.`,
    };
  }

  const expectedFields: Record<string, unknown> = {};
  for (const { fieldId, hubspotProperty } of fieldMap) {
    const field = workflow.fields.find((f) => f.id === fieldId);
    if (!field || field.value === undefined || field.value === null || field.value === '') {
      return {
        ok: false,
        workflowName: workflow.name,
        reason: `Field "${field?.name ?? fieldId}" has no configured value on "${workflow.name}" — set it in the dashboard before testing.`,
      };
    }
    expectedFields[hubspotProperty] = field.value;
  }

  return { ok: true, workflowName: workflow.name, expectedFields };
}

function isActionConfigured(workflow: RefoldConfigWorkflow, actionCode: string): boolean {
  return workflow.fields.some((field) => {
    if (!ACTION_FIELD_NAME_PATTERN.test(field.name)) return false;
    const value = field.value;
    if (Array.isArray(value)) return value.includes(actionCode);
    return value === actionCode;
  });
}
