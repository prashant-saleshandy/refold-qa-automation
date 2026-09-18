import { createHubspotClientFromEnv, type HubspotClient } from '../../clients/crms/hubspot/hubspot-client.js';
import type { CrmVerifier, FieldMismatch, RunContext, VerificationResult } from '../../core/types.js';
import {
  createHubspotCompanyVerifier,
  createHubspotDealVerifier,
  createHubspotEmailLogVerifier,
  createHubspotNoteVerifier,
  createHubspotTaskVerifier,
} from './object-verifiers.js';

/**
 * create-contact and update-contact both resolve to a HubSpot Contact.
 *
 * Per mined execution history (execution-plan.md §13), the update-* actions
 * are "search first" — they look up an existing object (by the prospect's
 * email, for contacts) and update it. This only finds something real when
 * run in the "update" phase of scripts/run-suite.ts's two-phase flow, AFTER
 * the "create" phase has already made that contact — see
 * execution-plan.md's phased-testing section. Running update-contact in
 * isolation, without a prior create-contact for the same prospect, will
 * correctly fail with "not found".
 */
const CONTACT_ACTIONS = new Set(['create-contact', 'update-contact']);

function createHubspotContactVerifier(client: HubspotClient): CrmVerifier {
  return {
    crm: 'hubspot',
    async verify(context: RunContext): Promise<VerificationResult> {
      // expectedFields is keyed directly by HubSpot property name — see
      // TestCase.expectedFields's docstring for why no id->property mapping
      // is needed here.
      const properties = ['email', ...Object.keys(context.testCase.expectedFields)];
      const contact = await client.waitForContactByEmail(context.prospectEmail, properties);

      if (!contact) {
        return {
          pass: false,
          layer: 'crm',
          mismatches: [{ field: 'contact', expected: 'exists', actual: 'not found' }],
        };
      }

      const mismatches: FieldMismatch[] = [];
      for (const [property, expected] of Object.entries(context.testCase.expectedFields)) {
        const actual = contact.properties[property];
        if (String(actual).toLowerCase() !== String(expected).toLowerCase()) {
          mismatches.push({ field: property, expected, actual });
        }
      }

      return {
        pass: mismatches.length === 0,
        layer: 'crm',
        mismatches,
        raw: contact,
      };
    },
  };
}

/**
 * Different action types create/update different HubSpot object types
 * (Contact, Deal, Company, Task, Note, Engagement) that each need their own
 * lookup-and-diff logic (a deal isn't findable by "email", for instance).
 * Deal/Company/Task/Note/Email-log are verified via association from the
 * resolved Contact — see object-verifiers.ts for why (we don't reliably
 * know a name/domain to search by directly for those object types).
 */
export function createHubspotVerifierForAction(action: string): CrmVerifier {
  if (CONTACT_ACTIONS.has(action)) {
    return createHubspotContactVerifier(createHubspotClientFromEnv());
  }

  switch (action) {
    case 'create-deal':
    case 'update-deal':
      return createHubspotDealVerifier();
    case 'create-company':
    case 'update-company':
      return createHubspotCompanyVerifier();
    case 'create-task':
      return createHubspotTaskVerifier();
    case 'create-note':
      return createHubspotNoteVerifier();
    case 'record-email-activity':
      return createHubspotEmailLogVerifier();
    default:
      return {
        crm: 'hubspot',
        async verify(): Promise<VerificationResult> {
          throw new Error(`No CRM verifier implemented yet for unrecognized action "${action}".`);
        },
      };
  }
}
