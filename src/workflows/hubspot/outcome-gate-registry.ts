import { PROSPECT_OUTCOME_GATE_FIELD } from './prospect-outcome-field-map.js';

/**
 * Per-workflow "Select Outcome (while ...)" gate field ids — see
 * prospect-outcome-field-map.ts's docstring. Only workflows with this
 * trigger-gate concept appear here; "Reply is Received" has none, so
 * lookups against it correctly return undefined and preflight skips the
 * outcome check entirely (see preflightWorkflowAction's `outcomeGateFieldId`
 * param).
 */
export const HUBSPOT_OUTCOME_GATE_FIELDS_BY_WORKFLOW: Record<string, Record<string, string>> = {
  '681368981acc0cbcd16295b0': PROSPECT_OUTCOME_GATE_FIELD, // Prospect Outcome is updated in Saleshandy
};

/**
 * How each workflow's trigger actually fires. "reply" (the default) means
 * TestMailboxClient auto-replying to the outbound test email. "outcome"
 * means calling SaleshandyEdgeClient.updateProspectOutcome() directly (the
 * internal edge API, NOT the public Open API — see SH-20244) — no
 * email/reply/IMAP wait needed at all, since the trigger is a direct API
 * call. See execution-plan.md §23/§24/§28.
 */
export type TriggerType = 'reply' | 'outcome' | 'unsubscribe' | 'bounce' | 'click';

export const HUBSPOT_TRIGGER_TYPE_BY_WORKFLOW: Record<string, TriggerType> = {
  '681368981acc0cbcd16295b0': 'outcome', // Prospect Outcome is updated in Saleshandy
  '681368981acc0cbcd16295ac': 'unsubscribe', // Prospect is Unsubscribed in Saleshandy
  '681368981acc0cbcd16295ad': 'bounce', // Email is Bounced in Saleshandy
  '681368981acc0cbcd16295ab': 'click', // Link is Clicked in Saleshandy
};

export function getTriggerType(workflowId: string): TriggerType {
  return HUBSPOT_TRIGGER_TYPE_BY_WORKFLOW[workflowId] ?? 'reply';
}
