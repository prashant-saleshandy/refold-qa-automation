/**
 * For each action code on a HubSpot workflow, which config field ids are
 * relevant and what HubSpot property each one resolves to. There's no way
 * to derive the destination property name from the config API's own
 * metadata (its `help_text` values like "contact_hubspot" are hints, not
 * the property key), so this has to be hand-maintained per action.
 *
 * Confirmed 2026-09-17 two ways:
 * 1. Live, for create-contact — by running it and inspecting the resulting
 *    execution's node input_data (see execution-plan.md §5).
 * 2. For everything else — by mining this SAME org's 900+ existing Refold
 *    execution history (all workflows sharing this HubSpot connection,
 *    especially "Email Sent from Saleshandy", which has the identical
 *    field structure) for real past node input_data on each action type.
 *    This required NO new test runs — a much better approach than
 *    hit-and-try once you pointed out the org almost certainly already had
 *    this data sitting in its execution log. See execution-plan.md §12.
 *
 * The 9 action codes come directly from the "Hubspot Action" dropdown on
 * the "Reply is Received in Saleshandy" workflow (read off the dashboard
 * 2026-09-17): Create/Update a Contact, Create/Update a Deal, Create/
 * Update a Company, Create a Task, Create a Note, Record(log) an Email
 * Activity. Exact slug strings are confirmed for create-contact only
 * (verified live); the rest are inferred from that naming pattern and
 * should be double-checked against a real execution the first time each
 * one is actually tested (the mined history proves the PROPERTY KEYS, not
 * necessarily the exact slug string Refold expects in the ActionN field).
 */
export const HUBSPOT_ACTION_FIELD_MAP: Record<string, Array<{ fieldId: string; hubspotProperty: string }>> = {
  // --- Confirmed live 2026-09-17 (our own test run) ---
  'create-contact': [
    { fieldId: '6557386d7e6887609eebe7a6', hubspotProperty: 'hs_lead_status' }, // Lead Status
    { fieldId: '655738817e6887609eebeb5b', hubspotProperty: 'lifecyclestage' }, // Lead Lifecycle
  ],

  // --- Property keys confirmed from execution history (exec
  // 6a76fa814707c6b2a5de7052, "Update Contact" node: real payload had
  // firstname/lastname/email/hs_lead_status/lifecyclestage/phone/jobtitle
  // + contactId). Field ids confirmed present in this workflow's config. ---
  'update-contact': [
    { fieldId: '6555f76c1c32659789ff07ad', hubspotProperty: 'hs_lead_status' }, // Update Lead Status
    { fieldId: '6555f7871c32659789ff0928', hubspotProperty: 'lifecyclestage' }, // Update Lead Lifecycle
  ],

  // --- Property keys confirmed from execution history (exec
  // 6a82b50a44cf075ff9c9828b, "Create Deal" node: real payload was exactly
  // {closedate, dealname, pipeline, dealstage, dealtype, hs_priority}). ---
  'create-deal': [
    { fieldId: '649e5ab26e4098e812baa2da', hubspotProperty: 'pipeline' }, // Select Pipeline (when to create)
    { fieldId: '649e5ab36e4098e812baa382', hubspotProperty: 'dealstage' }, // Select Pipeline Stage (when to create)
    { fieldId: '6565ad97a1a0cdc655f5fa92', hubspotProperty: 'dealtype' }, // Deal Type (while creating)
    { fieldId: '6565ae33a1a0cdc655f60272', hubspotProperty: 'hs_priority' }, // Deal Priority (while creating)
    { fieldId: '6565ae7aa1a0cdc655f60748', hubspotProperty: 'closedate' }, // Closing Date (while creating)
  ],
  // Update-deal's own node wasn't found in the mined history (only errored
  // create-deal attempts) — property keys assumed identical to create-deal
  // (standard HubSpot deal properties don't differ by create vs update).
  // Confirm against a real execution the first time this action is tested.
  'update-deal': [
    { fieldId: '6565ad5da1a0cdc655f5f2e9', hubspotProperty: 'pipeline' }, // Select Pipeline (when to update)
    { fieldId: '6565ad78a1a0cdc655f5f46e', hubspotProperty: 'dealstage' }, // Select Pipeline Stage (when to update)
    { fieldId: '6565ade2a1a0cdc655f6000f', hubspotProperty: 'dealtype' }, // Deal Type (while updating)
    { fieldId: '6565ae4da1a0cdc655f605aa', hubspotProperty: 'hs_priority' }, // Deal Priority (while updating)
    { fieldId: '6565ae91a1a0cdc655f608eb', hubspotProperty: 'closedate' }, // Closing Date (while updating)
  ],

  // --- Property keys confirmed from execution history (exec
  // 6a76fa814707c6b2a5de7052, "Create task for exixting contact" node:
  // real payload was {hs_task_subject, hs_timestamp, hs_task_status,
  // hs_task_priority, hs_task_type}). Note "Due In" resolves to
  // hs_timestamp, NOT hs_task_due_date as originally guessed —
  // hs_task_status ("NOT_STARTED") isn't user-configurable via any ActionN
  // field, so it's omitted here (nothing to assert against a config value). ---
  'create-task': [
    { fieldId: '6565aec9a1a0cdc655f60a93', hubspotProperty: 'hs_task_subject' }, // Task Title
    { fieldId: '6565aee8a1a0cdc655f60c40', hubspotProperty: 'hs_task_type' }, // Task Type
    { fieldId: '6565af0fa1a0cdc655f6252e', hubspotProperty: 'hs_task_priority' }, // Task Priority
    { fieldId: '6565af28a1a0cdc655f62df9', hubspotProperty: 'hs_timestamp' }, // Due In
  ],

  // --- Confirmed from execution history that these do NOT use fixed
  // ActionN dropdown fields at all — matches the earlier observation of no
  // field ids for these actions in this workflow's config:
  // - Company (exec 6a76f323fce280a73a56a32a, generic "hubspot" node):
  //   payload was just {name, domain} — driven entirely by the prospect's
  //   own Company/Company Domain fields, not by any dropdown config.
  // - Note (exec 6a76fa814707c6b2a5de7052, "Create Note" node): payload
  //   was {hs_note_body, hs_timestamp} — hs_note_body is an
  //   auto-generated template (sequence/step/sender info), not
  //   user-configurable via a dropdown field.
  // - Log Email Activity (exec 6a76f323fce280a73a56a32a, "Log Email"
  //   node): payload was {hs_timestamp, hs_email_direction,
  //   hs_email_subject, hs_email_status, hs_email_html} — also entirely
  //   auto-generated from the actual sent email, nothing to configure.
  // So there's genuinely nothing to assert here beyond "the object got
  // created" (CRM-side check) — these empty arrays are a confirmed
  // finding, not a placeholder. See execution-plan.md §12. ---
  'create-company': [],
  'update-company': [],
  'create-note': [],
  'record-email-activity': [], // confirmed live 2026-09-17 — "Record(log) an Email Activity in Hubspot"
};
