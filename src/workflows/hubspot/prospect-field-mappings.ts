/**
 * Prospect-data field mappings — a SEPARATE mechanism from field-map.ts.
 *
 * field-map.ts covers fixed, dashboard-configured VALUES (Lead Status,
 * Lead Lifecycle) that apply to every contact this action creates.
 *
 * This file covers the "Contact properties mapping v2" config field
 * (map_v2 type, id 675c00fea479eea87d37614f) — a table mapping SalesHandy
 * PROSPECT fields to HubSpot contact properties, applied per-prospect at
 * runtime using whatever value is on the specific prospect being processed.
 *
 * Confirmed live 2026-09-17:
 * - There's no working read endpoint for the mapping table itself. The
 *   single-field GET route (`/api/v2/public/config/field/{id}`) 404s (it's
 *   PUT-only per Refold's docs), and the full-config GET
 *   (`RefoldClient.getConfig()`) only returns this field's *schema*
 *   (available lhs/rhs options), not its currently-configured pairs.
 * - So unlike field-map.ts entries, these mappings can't be discovered
 *   or verified as "currently configured" via API — they're maintained
 *   here by hand to match whatever's actually set in the dashboard, and
 *   the test PROVIDES the value (by setting it on the imported prospect)
 *   rather than reading an existing one.
 * - SalesHandy field names/ids confirmed via GET /v1/fields; HubSpot
 *   property keys confirmed via the "Contact Properties" field's rhs
 *   options in the live config.
 */
export interface ProspectFieldMapping {
  /** Exact SalesHandy field name, as accepted by prospectList import keys. */
  saleshandyFieldName: string;
  hubspotProperty: string;
  /** Value this test sets on the prospect and expects to see on the contact. */
  testValue: string;
}

// The 2 default + 2 custom fields you configured in the dashboard mapping
// table — reused for every action that operates on a HubSpot Contact.
const CONTACT_MAPPINGS: ProspectFieldMapping[] = [
  { saleshandyFieldName: 'LinkedIn', hubspotProperty: 'hs_linkedin_url', testValue: 'https://linkedin.com/in/qa-test' },
  { saleshandyFieldName: 'Twitter', hubspotProperty: 'twitterhandle', testValue: 'qa_test_handle' },
  // Same target property as "LinkedIn" above — set to the same value so
  // the result is unambiguous regardless of mapping application order.
  { saleshandyFieldName: 'LinkedIn Profile URL 4', hubspotProperty: 'hs_linkedin_url', testValue: 'https://linkedin.com/in/qa-test' },
  { saleshandyFieldName: 'Annual Revenue 3', hubspotProperty: 'annualrevenue', testValue: '500000' },
];

export const HUBSPOT_PROSPECT_FIELD_MAPPINGS: Record<string, ProspectFieldMapping[]> = {
  // --- Confirmed live 2026-09-17 ---
  'create-contact': CONTACT_MAPPINGS,
  // update-contact also writes to a Contact object, so the same mapping
  // table should apply — NOT yet confirmed live (untested action).
  'update-contact': CONTACT_MAPPINGS,

  // --- Deal/Company objects have their OWN separate mapping fields
  // ("Deal Properties" / "Company Properties" in the top-level config,
  // distinct field ids from "Contact properties mapping v2") which have
  // not been configured or discovered yet. Do NOT reuse CONTACT_MAPPINGS
  // here — a deal/company object has no "twitterhandle" property. These
  // stay empty until that mapping is set up and confirmed the same way
  // the contact one was (see execution-plan.md §9). ---
  'create-deal': [],
  'update-deal': [],
  'create-company': [],
  'update-company': [],
  'create-task': [],
  'create-note': [],
  'record-email-activity': [],
};
