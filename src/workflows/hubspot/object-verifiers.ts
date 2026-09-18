import { createHubspotClientFromEnv } from '../../clients/crms/hubspot/hubspot-client.js';
import type { CrmVerifier, FieldMismatch, RunContext, VerificationResult } from '../../core/types.js';

/**
 * Generic verifier for any HubSpot object type reached via association from
 * the run's Contact (Deal, Company, Task, Note, Email engagement) — used for
 * every action except create-contact/update-contact (see verifier.ts).
 *
 * Why associations instead of searching by name/domain: we don't reliably
 * know the exact value Refold uses for a deal's name or a company's domain
 * (field-map.ts flags this uncertainty explicitly for update-deal). Walking
 * the association from the contact we DO know how to find (by email) avoids
 * needing to guess that key at all — whatever object Refold actually
 * attached to this contact is the one we check, using HubSpot's own real
 * association, not our assumption of what it should be named.
 *
 * `propertiesToCheck` empty (Company/Note/Email-log — see field-map.ts,
 * these actions have no dashboard-configured fields) means this verifier
 * only confirms existence: the object was created/associated at all. A
 * non-empty list also diffs those properties against the test case's
 * expected values, same as the Contact verifier.
 */
function createAssociatedObjectVerifier(objectType: string, propertiesToCheck: string[]): CrmVerifier {
  const client = createHubspotClientFromEnv();

  return {
    crm: 'hubspot',
    async verify(context: RunContext): Promise<VerificationResult> {
      const contact = await client.waitForContactByEmail(context.prospectEmail, ['email']);
      if (!contact) {
        return {
          pass: false,
          layer: 'crm',
          mismatches: [{ field: 'contact', expected: 'exists (needed to find associated object)', actual: 'not found' }],
        };
      }

      const associatedIds = await client.waitForAssociatedObject(contact.id, objectType);
      if (associatedIds.length === 0) {
        return {
          pass: false,
          layer: 'crm',
          mismatches: [{ field: objectType, expected: 'at least one associated object', actual: 'none found' }],
        };
      }

      if (propertiesToCheck.length === 0) {
        // Existence-only check — nothing configurable to diff (see docstring).
        return { pass: true, layer: 'crm', mismatches: [], raw: { id: associatedIds[0] } };
      }

      const expectedFields = context.testCase.expectedFields;
      const properties = await client.getObjectProperties(objectType, associatedIds[0]!, propertiesToCheck);

      const mismatches: FieldMismatch[] = [];
      for (const [property, expected] of Object.entries(expectedFields)) {
        const actual = properties[property];
        if (String(actual).toLowerCase() !== String(expected).toLowerCase()) {
          mismatches.push({ field: property, expected, actual });
        }
      }

      return { pass: mismatches.length === 0, layer: 'crm', mismatches, raw: { id: associatedIds[0], properties } };
    },
  };
}

export function createHubspotDealVerifier(): CrmVerifier {
  return createAssociatedObjectVerifier('deals', ['pipeline', 'dealstage', 'dealtype', 'hs_priority', 'closedate']);
}

export function createHubspotCompanyVerifier(): CrmVerifier {
  // No dashboard-configured fields for company actions (§13) — existence only.
  return createAssociatedObjectVerifier('companies', []);
}

export function createHubspotTaskVerifier(): CrmVerifier {
  return createAssociatedObjectVerifier('tasks', ['hs_task_subject', 'hs_task_type', 'hs_task_priority', 'hs_timestamp']);
}

export function createHubspotNoteVerifier(): CrmVerifier {
  // No dashboard-configured fields (auto-generated body, §13) — existence only.
  return createAssociatedObjectVerifier('notes', []);
}

export function createHubspotEmailLogVerifier(): CrmVerifier {
  // No dashboard-configured fields (auto-generated from the real sent email, §13) — existence only.
  return createAssociatedObjectVerifier('emails', []);
}
