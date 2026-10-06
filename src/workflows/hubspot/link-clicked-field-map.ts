/**
 * Field map for "Link is Clicked in Saleshandy" (id
 * `681368981acc0cbcd16295ab`), read off the live dashboard config
 * 2026-09-28. Same action set/property keys as the sibling workflows, own
 * field ids. No "Select Outcome" gates on this workflow.
 */
export const LINK_CLICKED_ACTION_FIELD_MAP: Record<string, Array<{ fieldId: string; hubspotProperty: string }>> = {
  'create-contact': [
    { fieldId: '652d08f0aa1edef92d6c325b', hubspotProperty: 'hs_lead_status' }, // Lead Status
    { fieldId: '652d0926aa1edef92d6cbc26', hubspotProperty: 'lifecyclestage' }, // Lead Lifecycle
  ],
  'update-contact': [
    { fieldId: '6555f7b21c32659789ff12c1', hubspotProperty: 'hs_lead_status' }, // Update Lead Status
    { fieldId: '6555f7c31c32659789ff1437', hubspotProperty: 'lifecyclestage' }, // Update Lead Lifecycle
  ],
  'create-deal': [
    { fieldId: '649e5ab26e4098e812baa2da', hubspotProperty: 'pipeline' }, // Select Pipeline (when to create)
    { fieldId: '649e5ab36e4098e812baa382', hubspotProperty: 'dealstage' }, // Select Pipeline Stage (when to create)
    { fieldId: '6565b5ec81ca20bd6df03c06', hubspotProperty: 'dealtype' }, // Deal Type (while creating)
    { fieldId: '6565b71481ca20bd6df1d765', hubspotProperty: 'hs_priority' }, // Deal Priority (while creating)
    { fieldId: '6565b8aa81ca20bd6df25d6c', hubspotProperty: 'closedate' }, // Closing Date (while creating)
  ],
  'update-deal': [
    { fieldId: '6565b3aaa1a0cdc655f6d53a', hubspotProperty: 'pipeline' }, // Select Pipeline (when to update)
    { fieldId: '6565b45fa1a0cdc655f6ed61', hubspotProperty: 'dealstage' }, // Select Pipeline Stage (when to update)
    { fieldId: '6565b68281ca20bd6df0eef9', hubspotProperty: 'dealtype' }, // Deal Type (while updating)
    { fieldId: '6565b79581ca20bd6df20446', hubspotProperty: 'hs_priority' }, // Deal Priority (while updating)
    { fieldId: '6565b8ff81ca20bd6df271f4', hubspotProperty: 'closedate' }, // Closing Date (while updating)
  ],
  'create-task': [
    { fieldId: '6565b96a81ca20bd6df2aae4', hubspotProperty: 'hs_task_subject' }, // Task Title
    { fieldId: '6565ba0581ca20bd6df2e358', hubspotProperty: 'hs_task_type' }, // Task Type
    { fieldId: '6565ba8c81ca20bd6df2f769', hubspotProperty: 'hs_task_priority' }, // Task Priority
    { fieldId: '6565bafe81ca20bd6df34310', hubspotProperty: 'hs_timestamp' }, // Due In
  ],
  'create-company': [],
  'update-company': [],
  'create-note': [],
  'record-email-activity': [],
};
