import { HUBSPOT_ACTION_FIELD_MAP } from './field-map.js';
import { PROSPECT_UNSUBSCRIBED_ACTION_FIELD_MAP } from './prospect-unsubscribed-field-map.js';
import { PROSPECT_OUTCOME_ACTION_FIELD_MAP } from './prospect-outcome-field-map.js';
import { EMAIL_BOUNCED_ACTION_FIELD_MAP } from './email-bounced-field-map.js';
import { LINK_CLICKED_ACTION_FIELD_MAP } from './link-clicked-field-map.js';

/**
 * Field maps are keyed by ACTION CODE (e.g. "create-deal"), but the same
 * action code means different Refold field ids on different workflows
 * (e.g. "Reply is Received" and "Prospect Outcome is updated" both have a
 * create-deal action, with separate config fields for each). A single flat
 * map keyed only by action code broke once a second workflow reused the
 * same action codes — this registry is keyed by workflowId first, so each
 * workflow's map stays isolated.
 */
export const HUBSPOT_FIELD_MAPS_BY_WORKFLOW: Record<string, Record<string, Array<{ fieldId: string; hubspotProperty: string }>>> = {
  '681368981acc0cbcd16295a9': HUBSPOT_ACTION_FIELD_MAP, // Reply is Received in Saleshandy
  '681368981acc0cbcd16295b0': PROSPECT_OUTCOME_ACTION_FIELD_MAP, // Prospect Outcome is updated in Saleshandy
  '681368981acc0cbcd16295ac': PROSPECT_UNSUBSCRIBED_ACTION_FIELD_MAP, // Prospect is Unsubscribed in Saleshandy
  '681368981acc0cbcd16295ad': EMAIL_BOUNCED_ACTION_FIELD_MAP, // Email is Bounced in Saleshandy
  '681368981acc0cbcd16295ab': LINK_CLICKED_ACTION_FIELD_MAP, // Link is Clicked in Saleshandy
};
