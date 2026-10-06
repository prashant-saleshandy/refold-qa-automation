/**
 * Prospect-data field mappings — a SEPARATE mechanism from field-map.ts.
 *
 * field-map.ts covers fixed, dashboard-configured VALUES (Lead Status,
 * Lead Lifecycle) that apply to every contact this action creates.
 *
 * This file covers the app-level "Contact Properties" / "Deal Properties" /
 * "Company Properties" config fields — tables mapping SalesHandy PROSPECT
 * fields to HubSpot object properties, applied per-prospect at runtime
 * using whatever value is on the specific prospect being processed.
 *
 * Rebuilt from scratch 2026-09-22 for the new SalesHandy account
 * (linked_account_id 86998) — the old account's mappings (LinkedIn/Twitter/
 * "LinkedIn Profile URL 4"/"Annual Revenue 3") no longer apply.
 *
 * Unlike the old "Contact properties mapping v2" (map_v2) field, these three
 * are plain "map"-type fields and their CURRENTLY CONFIGURED values ARE
 * readable live via RefoldClient.getConfig() — confirmed 2026-09-22 (the
 * app-level `fields[]` array, not the workflow-level ones). Verified every
 * mapping below against HubSpot's real property metadata
 * (`GET /crm/v3/properties/{object}/{property}`, checking
 * `modificationMetadata.readOnlyValue`) before committing to it — several
 * options Refold offers by name (e.g. Deal's "Created by user ID" /
 * "Updated by user ID" / "Deal Score") are HubSpot-calculated, read-only
 * properties that silently reject writes; "description" and "closed lost/
 * won reason" aren't offered as Deal-mapping options at all despite
 * existing on the object.
 */
export interface ProspectFieldMapping {
  /** Exact SalesHandy field name, as accepted by prospectList import keys. */
  saleshandyFieldName: string;
  hubspotProperty: string;
  /** Value this test sets on the prospect and expects to see on the contact. */
  testValue: string;
}

// Live "Contact Properties" mapping: firstName/customFirstName both target
// "firstname", lastName/customLastName both target "lastname" (same
// property, two source fields) — ambiguous unless both sides carry the
// SAME value, so these match the base prospect's fixed First/Last Name
// ("QA"/"Test" — see setupSaleshandySequence in test-runner.ts) rather than
// a distinct QA value. firstName/lastName themselves aren't listed here:
// they're the prospect's core identity fields, already set unconditionally
// by setupSaleshandySequence, not something this "extra fields" mechanism
// needs to inject.
const CONTACT_MAPPINGS: ProspectFieldMapping[] = [
  { saleshandyFieldName: 'custom_first_name', hubspotProperty: 'firstname', testValue: 'QA' },
  { saleshandyFieldName: 'custom_last_name', hubspotProperty: 'lastname', testValue: 'Test' },
];

// Live "Deal Properties" mapping — confirmed writable, non-colliding
// targets (see file docstring for what was ruled out and why).
const DEAL_MAPPINGS: ProspectFieldMapping[] = [
  { saleshandyFieldName: 'Company Revenue', hubspotProperty: 'amount', testValue: '50000' },
  { saleshandyFieldName: 'Website', hubspotProperty: 'hs_campaign', testValue: 'qa-test-campaign' },
  // Number-type HubSpot properties — text-type SalesHandy fields, so the
  // test value is a numeric-looking string (HubSpot accepts this fine).
  // hs_forecast_probability confirmed live 2026-09-22: HubSpot rejects
  // anything outside 0-1 ("50" errors with "not a valid probability value" —
  // it's a fraction, not a 0-100 percentage).
  { saleshandyFieldName: 'Deal Custom 1', hubspotProperty: 'hs_forecast_probability', testValue: '0.5' },
  { saleshandyFieldName: 'Deal Custom 2', hubspotProperty: 'hs_exchange_rate', testValue: '1.25' },
];

// Live "Company Properties" mapping — confirmed writable, non-colliding
// targets.
const COMPANY_MAPPINGS: ProspectFieldMapping[] = [
  { saleshandyFieldName: 'Company Custom 1', hubspotProperty: 'state', testValue: 'QA Test State' },
  { saleshandyFieldName: 'Twitter', hubspotProperty: 'address', testValue: '123 QA Test St' },
  { saleshandyFieldName: 'Company LinkedIn', hubspotProperty: 'about_us', testValue: 'QA test about-us text' },
  // "Employee range" despite the name is a plain string property on the
  // HubSpot side (not an enumeration). BUT "Company Custom 2" itself is a
  // NUMBER-type field on the SalesHandy side — confirmed live 2026-09-22
  // that a non-numeric value here ("51-200") makes SalesHandy's prospect
  // import silently reject the ENTIRE prospect record ("Mismatch in custom
  // field type", visible only in the import's failedProspectsURL report,
  // which nothing in this harness checks — see
  // SaleshandyClient.waitForImportComplete). Must be a plain number.
  { saleshandyFieldName: 'Company Custom 2', hubspotProperty: 'hs_employee_range', testValue: '150' },
];

export const HUBSPOT_PROSPECT_FIELD_MAPPINGS: Record<string, ProspectFieldMapping[]> = {
  'create-contact': CONTACT_MAPPINGS,
  'update-contact': CONTACT_MAPPINGS,
  'create-deal': DEAL_MAPPINGS,
  'update-deal': DEAL_MAPPINGS,
  'create-company': COMPANY_MAPPINGS,
  'update-company': COMPANY_MAPPINGS,
  'create-task': [],
  'create-note': [],
  'record-email-activity': [],
};
