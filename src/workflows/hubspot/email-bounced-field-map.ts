/**
 * Field map for "Email is Bounced in Saleshandy" (id
 * `681368981acc0cbcd16295ad`), read off the live dashboard config
 * 2026-09-28. Same action set/property keys as the sibling workflows, own
 * field ids. No "Select Outcome" gates on this workflow.
 */
export const EMAIL_BOUNCED_ACTION_FIELD_MAP: Record<string, Array<{ fieldId: string; hubspotProperty: string }>> = {
  'create-contact': [
    { fieldId: '652d09cfaa1edef92d6d2fad', hubspotProperty: 'hs_lead_status' }, // Lead Status
    { fieldId: '652d0a95aa1edef92d6e5683', hubspotProperty: 'lifecyclestage' }, // Lead Lifecycle
  ],
  'update-contact': [
    { fieldId: '6555f8441c32659789ff2897', hubspotProperty: 'hs_lead_status' }, // Update Lead Status
    { fieldId: '6555f8541c32659789ff2a08', hubspotProperty: 'lifecyclestage' }, // Update Lead Lifecycle
  ],
  'create-deal': [
    { fieldId: '649e5ab26e4098e812baa2da', hubspotProperty: 'pipeline' }, // Select Pipeline (when to create)
    { fieldId: '649e5ab36e4098e812baa382', hubspotProperty: 'dealstage' }, // Select Pipeline Stage (when to create)
    { fieldId: '6565b60881ca20bd6df041e9', hubspotProperty: 'dealtype' }, // Deal Type (while creating)
    { fieldId: '6565b72a81ca20bd6df1e19d', hubspotProperty: 'hs_priority' }, // Deal Priority (while creating)
    { fieldId: '6565b8b681ca20bd6df25eb2', hubspotProperty: 'closedate' }, // Closing Date (while creating)
  ],
  'update-deal': [
    { fieldId: '6565b3bfa1a0cdc655f6dc48', hubspotProperty: 'pipeline' }, // Select Pipeline (when to update)
    { fieldId: '6565b47581ca20bd6defbc89', hubspotProperty: 'dealstage' }, // Select Pipeline Stage (when to update)
    { fieldId: '6565b69481ca20bd6df0f8ff', hubspotProperty: 'dealtype' }, // Deal Type (while updating)
    { fieldId: '6565b7b381ca20bd6df20588', hubspotProperty: 'hs_priority' }, // Deal Priority (while updating)
    { fieldId: '6565b90b81ca20bd6df27615', hubspotProperty: 'closedate' }, // Closing Date (while updating)
  ],
  'create-task': [
    { fieldId: '6565b9a481ca20bd6df2b102', hubspotProperty: 'hs_task_subject' }, // Task Title
    { fieldId: '6565ba1781ca20bd6df2ec13', hubspotProperty: 'hs_task_type' }, // Task Type
    { fieldId: '6565ba9f81ca20bd6df2fce7', hubspotProperty: 'hs_task_priority' }, // Task Priority
    { fieldId: '6565bb0a81ca20bd6df3446a', hubspotProperty: 'hs_timestamp' }, // Due In
  ],
  'create-company': [],
  'update-company': [],
  'create-note': [],
  'record-email-activity': [],
};
