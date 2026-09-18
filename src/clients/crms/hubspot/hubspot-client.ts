import axios, { type AxiosInstance } from 'axios';
import { requireEnv } from '../../../config/env.js';

export interface HubspotContact {
  id: string;
  properties: Record<string, string | null>;
}

export class HubspotClient {
  private readonly http: AxiosInstance;

  constructor(config: { baseUrl: string; accessToken: string }) {
    this.http = axios.create({
      baseURL: config.baseUrl,
      timeout: 30_000,
      headers: { Authorization: `Bearer ${config.accessToken}` },
    });
  }

  /**
   * Finds a contact by exact email using HubSpot's CRM search API, returning
   * the properties we need to diff against a test case's expected fields.
   */
  async findContactByEmail(
    email: string,
    properties: string[] = ['email', 'hs_lead_status', 'lifecyclestage'],
  ): Promise<HubspotContact | null> {
    const { data } = await this.http.post('/crm/v3/objects/contacts/search', {
      filterGroups: [
        { filters: [{ propertyName: 'email', operator: 'EQ', value: email }] },
      ],
      properties,
      limit: 1,
    });

    const result = data?.results?.[0];
    if (!result) return null;
    return { id: result.id, properties: result.properties };
  }

  /**
   * HubSpot's search API is eventually consistent — confirmed live
   * 2026-09-17 that a contact created seconds earlier can still return zero
   * results, even though the object already exists (visible via direct
   * lookup, and in the UI). Poll instead of a single fixed-delay attempt.
   */
  async waitForContactByEmail(
    email: string,
    properties: string[] = ['email', 'hs_lead_status', 'lifecyclestage'],
    options: { timeoutMs?: number; pollIntervalMs?: number } = {},
  ): Promise<HubspotContact | null> {
    const timeoutMs = options.timeoutMs ?? 45_000;
    const pollIntervalMs = options.pollIntervalMs ?? 5_000;
    const deadline = Date.now() + timeoutMs;

    let lastResult: HubspotContact | null = null;
    while (Date.now() < deadline) {
      lastResult = await this.findContactByEmail(email, properties);
      if (lastResult) return lastResult;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    return lastResult;
  }

  async findDealByName(
    dealName: string,
    properties: string[] = ['dealname', 'dealstage', 'pipeline', 'dealtype', 'closedate'],
  ): Promise<{ id: string; properties: Record<string, string | null> } | null> {
    const { data } = await this.http.post('/crm/v3/objects/deals/search', {
      filterGroups: [
        { filters: [{ propertyName: 'dealname', operator: 'EQ', value: dealName }] },
      ],
      properties,
      limit: 1,
    });

    const result = data?.results?.[0];
    if (!result) return null;
    return { id: result.id, properties: result.properties };
  }

  /**
   * Object ids associated with a contact for a given object type (e.g.
   * 'deals', 'companies', 'tasks', 'notes', 'emails') — the generic lookup
   * used to find whatever a create- or update- action attached to the
   * contact, without needing to guess a name/domain to search by (which we
   * don't reliably know for Deal/Company — see
   * src/workflows/hubspot/object-verifiers.ts).
   */
  async getAssociatedObjectIds(contactId: string, toObjectType: string): Promise<string[]> {
    const { data } = await this.http.get(
      `/crm/v4/objects/contacts/${contactId}/associations/${toObjectType}`,
    );
    return (data?.results ?? []).map((r: { toObjectId: string }) => r.toObjectId);
  }

  /** Generic property fetch for any object type, by id. */
  async getObjectProperties(
    objectType: string,
    objectId: string,
    properties: string[],
  ): Promise<Record<string, string | null>> {
    const { data } = await this.http.get(`/crm/v3/objects/${objectType}/${objectId}`, {
      params: { properties: properties.join(',') },
    });
    return data.properties;
  }

  /**
   * Polls for at least one object of `toObjectType` to show up associated
   * with the contact — same eventual-consistency reasoning as
   * waitForContactByEmail. Returns the most recently created one (HubSpot
   * associations are typically returned newest-first, but we don't rely on
   * that — see the caller in object-verifiers.ts for how ties are broken
   * when multiple objects of the same type are already associated).
   */
  async waitForAssociatedObject(
    contactId: string,
    toObjectType: string,
    options: { timeoutMs?: number; pollIntervalMs?: number } = {},
  ): Promise<string[]> {
    const timeoutMs = options.timeoutMs ?? 45_000;
    const pollIntervalMs = options.pollIntervalMs ?? 5_000;
    const deadline = Date.now() + timeoutMs;

    let lastResult: string[] = [];
    while (Date.now() < deadline) {
      lastResult = await this.getAssociatedObjectIds(contactId, toObjectType);
      if (lastResult.length > 0) return lastResult;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    return lastResult;
  }
}

/** Shared construction from env vars — used by the verifier and by anything
 * (e.g. seeding) that needs to talk to HubSpot directly, bypassing Refold. */
export function createHubspotClientFromEnv(): HubspotClient {
  return new HubspotClient({
    baseUrl: requireEnv('HUBSPOT_BASE_URL'),
    accessToken: requireEnv('HUBSPOT_ACCESS_TOKEN'),
  });
}
