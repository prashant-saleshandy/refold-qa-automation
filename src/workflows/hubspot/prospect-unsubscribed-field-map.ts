/**
 * Field map for "Prospect is Unsubscribed in Saleshandy" (id
 * `681368981acc0cbcd16295ac`), read off the live dashboard config
 * 2026-09-25. Same action set/property keys as the sibling workflows, own
 * field ids. No "Select Outcome" gates on this workflow.
 */
export const PROSPECT_UNSUBSCRIBED_ACTION_FIELD_MAP: Record<string, Array<{ fieldId: string; hubspotProperty: string }>> = {
  'create-contact': [
    { fieldId: '652d095caa1edef92d6cd04c', hubspotProperty: 'hs_lead_status' }, // Lead Status
    { fieldId: '652d099faa1edef92d6d2e18', hubspotProperty: 'lifecyclestage' }, // Lead Lifecycle
  ],
  'update-contact': [
    { fieldId: '6555f7e81c32659789ff1db0', hubspotProperty: 'hs_lead_status' }, // Update Lead Status
    { fieldId: '6555f80c1c32659789ff1f21', hubspotProperty: 'lifecyclestage' }, // Update Lead Lifecycle
  ],
  'create-deal': [
    { fieldId: '649e5ab26e4098e812baa2da', hubspotProperty: 'pipeline' }, // Select Pipeline (when to create)
    { fieldId: '649e5ab36e4098e812baa382', hubspotProperty: 'dealstage' }, // Select Pipeline Stage (when to create)
    { fieldId: '6565b5f581ca20bd6df03d9c', hubspotProperty: 'dealtype' }, // Deal Type (while creating)
    { fieldId: '6565b71f81ca20bd6df1e0aa', hubspotProperty: 'hs_priority' }, // Deal Priority (while creating)
    { fieldId: '6565b8b081ca20bd6df25e0f', hubspotProperty: 'closedate' }, // Closing Date (while creating)
  ],
  'update-deal': [
    { fieldId: '6565b3b4a1a0cdc655f6d6b7', hubspotProperty: 'pipeline' }, // Select Pipeline (when to update)
    { fieldId: '6565b46c81ca20bd6defb990', hubspotProperty: 'dealstage' }, // Select Pipeline Stage (when to update)
    { fieldId: '6565b68d81ca20bd6df0f2d2', hubspotProperty: 'dealtype' }, // Deal Type (while updating)
    { fieldId: '6565b7a881ca20bd6df204e7', hubspotProperty: 'hs_priority' }, // Deal Priority (while updating)
    { fieldId: '6565b90581ca20bd6df27470', hubspotProperty: 'closedate' }, // Closing Date (while updating)
  ],
  'create-task': [
    { fieldId: '6565b99d81ca20bd6df2b05b', hubspotProperty: 'hs_task_subject' }, // Task Title
    { fieldId: '6565ba1081ca20bd6df2e69b', hubspotProperty: 'hs_task_type' }, // Task Type
    { fieldId: '6565ba9281ca20bd6df2fc3c', hubspotProperty: 'hs_task_priority' }, // Task Priority
    { fieldId: '6565bb0481ca20bd6df343bd', hubspotProperty: 'hs_timestamp' }, // Due In
  ],
  'create-company': [],
  'update-company': [],
  'create-note': [],
  'record-email-activity': [],
};
