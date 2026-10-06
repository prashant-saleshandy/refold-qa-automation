/**
 * Field map for the "Prospect Outcome is updated in Saleshandy" workflow
 * (id `681368981acc0cbcd16295b0`) — see field-map.ts's docstring for the
 * general approach. This workflow shares the exact same underlying HubSpot
 * action nodes as "Reply is Received in Saleshandy" (confirmed: identical
 * property-key shapes for deal/task/contact fields, mined from this
 * connection's own historical executions on THIS workflow on 2026-09-18),
 * just with its own Refold field ids and one extra wrinkle — see below.
 *
 * IMPORTANT DIFFERENCE from field-map.ts: this workflow gates each action
 * on a "Select Outcome (while ...)" field — e.g. `create-deal` only fires
 * when the triggering SalesHandy outcome update matches whatever outcome
 * is configured there (confirmed live via mined execution history: a
 * "Check Outcome" rule node compares the event's outcome against this
 * field's value before the action node runs). That field is a TRIGGER
 * GATE, not a value sent to HubSpot — it must NOT be added to
 * expectedFields here (the actual action node's input_data never contains
 * it). See prospect-outcome-outcome-map.ts for where it's used instead.
 */
export const PROSPECT_OUTCOME_ACTION_FIELD_MAP: Record<string, Array<{ fieldId: string; hubspotProperty: string }>> = {
  'create-contact': [
    { fieldId: '652d09eeaa1edef92d6d31b2', hubspotProperty: 'hs_lead_status' }, // Lead Status
    { fieldId: '652d0a78aa1edef92d6e5477', hubspotProperty: 'lifecyclestage' }, // Lead Lifecycle
  ],
  'update-contact': [
    { fieldId: '6555f8ee1c32659789ff91e2', hubspotProperty: 'hs_lead_status' }, // Update Lead Status
    { fieldId: '6555f9011c32659789ff936e', hubspotProperty: 'lifecyclestage' }, // Update Lead Lifecycle
  ],
  'create-deal': [
    { fieldId: '649e5ab26e4098e812baa2da', hubspotProperty: 'pipeline' }, // Select Pipeline (when to create)
    { fieldId: '649e5ab36e4098e812baa382', hubspotProperty: 'dealstage' }, // Select Pipeline Stage (when to create)
    { fieldId: '6565b5cf81ca20bd6df01928', hubspotProperty: 'dealtype' }, // Deal Type (while creating)
    { fieldId: '6565b6d881ca20bd6df1c747', hubspotProperty: 'hs_priority' }, // Deal Priority (while creating)
    { fieldId: '6565b89d81ca20bd6df257fc', hubspotProperty: 'closedate' }, // Closing Date (while creating)
  ],
  'update-deal': [
    { fieldId: '6565b381a1a0cdc655f6cf0e', hubspotProperty: 'pipeline' }, // Select Pipeline (when to update)
    { fieldId: '6565b442a1a0cdc655f6ea24', hubspotProperty: 'dealstage' }, // Select Pipeline Stage (when to update)
    { fieldId: '6565b66c81ca20bd6df0e995', hubspotProperty: 'dealtype' }, // Deal Type (while updating)
    { fieldId: '6565b76a81ca20bd6df2007f', hubspotProperty: 'hs_priority' }, // Deal Priority (while updating)
    { fieldId: '6565b8ee81ca20bd6df27058', hubspotProperty: 'closedate' }, // Closing Date (while updating)
  ],
  'create-task': [
    { fieldId: '6565b95f81ca20bd6df2a879', hubspotProperty: 'hs_task_subject' }, // Task Title
    { fieldId: '6565b9df81ca20bd6df2dca7', hubspotProperty: 'hs_task_type' }, // Task Type
    { fieldId: '6565ba7f81ca20bd6df2f611', hubspotProperty: 'hs_task_priority' }, // Task Priority
    { fieldId: '6565baef81ca20bd6df341b4', hubspotProperty: 'hs_timestamp' }, // Due In
  ],
  // Same as field-map.ts's finding for the identical action types on
  // "Reply is Received" — no configurable dropdown fields at all.
  'create-company': [],
  'update-company': [],
  'create-note': [],
  'record-email-activity': [],
};

/**
 * The "Select Outcome (while ...)" field id per action — the trigger gate
 * described in this file's top docstring. `preflightWorkflowAction` doesn't
 * know about this (it's specific to this one workflow), so it's checked
 * separately — see scripts/run-suite.ts's per-workflow wiring once this is
 * used for real. Actions without an outcome gate (company/note/email-log)
 * are omitted — same actions that have no configurable fields at all.
 */
export const PROSPECT_OUTCOME_GATE_FIELD: Record<string, string> = {
  'create-contact': '64be7b2339ec788238d3f639', // Select Outcome (while creating contact)
  'update-contact': '6556219b1c32659789074711', // Select Outcome (while updating contact)
  'create-task': '6592b15aba07160153400213', // Select Outcome (while creating task)
  'create-deal': '6592b272ba071601534025db', // Select Outcome (While creating deal)
  'update-deal': '6592b29dba0716015340269a', // Select Outcome (while updating deal)
  'create-company': '6592b3e1ba0716015340546b', // Select Outcome (while creating company)
  'update-company': '6592b32dba07160153402fb9', // Select Outcome (while updating company)
};
