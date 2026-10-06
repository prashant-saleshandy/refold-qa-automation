import { createHubspotClientFromEnv, type HubspotClient } from '../../clients/crms/hubspot/hubspot-client.js';
import { isRelativeDayField, relativeDayMatches } from '../../core/test-runner.js';
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
 *
 * `anchorTypes` (default just `['contacts']`) lists which object(s) to walk
 * the association FROM, tried in order until one finds something.
 * Confirmed live 2026-09-22: this workflow's Note/Email-log actions attach
 * to the Contact by default, but attach to a Deal or Company instead if
 * that sibling action also created one in the same run (an intentional,
 * confirmed behavior — see execution-plan.md) — checking contact-only made
 * this verifier report "none found" on runs where it correctly attached
 * elsewhere instead.
 */
async function findAssociatedIdsViaAnyAnchor(
  client: HubspotClient,
  contactId: string,
  objectType: string,
  anchorTypes: string[],
): Promise<string[]> {
  for (const anchor of anchorTypes) {
    if (anchor === 'contacts') {
      // eslint-disable-next-line no-await-in-loop
      const ids = await client.waitForAssociatedObject(contactId, objectType, { timeoutMs: 15_000 });
      if (ids.length > 0) return ids;
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const anchorIds = await client.getAssociatedObjectIds(contactId, anchor);
    if (anchorIds.length === 0) continue;
    // eslint-disable-next-line no-await-in-loop
    const ids = await client.getAssociatedObjectIds(anchorIds[0]!, objectType, anchor);
    if (ids.length > 0) return ids;
  }
  return [];
}

function createAssociatedObjectVerifier(
  objectType: string,
  propertiesToCheck: string[],
  anchorTypes: string[] = ['contacts'],
): CrmVerifier {
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

      const associatedIds = await findAssociatedIdsViaAnyAnchor(client, contact.id, objectType, anchorTypes);
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
      // Fetch whatever expectedFields actually needs, not just the static
      // propertiesToCheck list passed at verifier-construction time — the
      // live dashboard config can add extra keys (e.g. deal custom fields
      // under "additional_fields") that propertiesToCheck doesn't know
      // about, and a property HubSpot never returns reads as undefined
      // regardless of its real value.
      const properties = await client.getObjectProperties(objectType, associatedIds[0]!, Object.keys(expectedFields));

      const mismatches: FieldMismatch[] = [];
      for (const [property, expected] of Object.entries(expectedFields)) {
        const actual = properties[property];
        // Same "N days from now" tolerance as the Refold-layer check (see
        // test-runner.ts's isRelativeDayField) — without this, a relative-day
        // config value (e.g. "10") never matches the absolute date HubSpot
        // actually stores (e.g. "2026-10-02"), even when it's exactly right.
        if (isRelativeDayField(expected, actual)) {
          if (!relativeDayMatches(expected as number, actual as string)) {
            mismatches.push({ field: property, expected, actual });
          }
          continue;
        }
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
  // May attach to contact, deal, or company — see anchorTypes docstring.
  return createAssociatedObjectVerifier('notes', [], ['contacts', 'deals', 'companies']);
}

export function createHubspotEmailLogVerifier(): CrmVerifier {
  // No dashboard-configured fields (auto-generated from the real sent email, §13) — existence only.
  // May attach to contact, deal, or company — see anchorTypes docstring.
  return createAssociatedObjectVerifier('emails', [], ['contacts', 'deals', 'companies']);
}
