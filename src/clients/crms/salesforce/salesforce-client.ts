/**
 * Salesforce client — NOT YET IMPLEMENTED.
 *
 * Salesforce needs its own OAuth (Connected App, username-password or
 * client-credentials flow) before this can be built — see .env.example for
 * the placeholder vars and execution-plan.md §9 (Open Items).
 *
 * Boundary rule: this file must never import from hubspot/, pipedrive/, or
 * zoho/ — see execution-plan.md §7.
 */
export class SalesforceClient {
  constructor(_config: { instanceUrl: string; accessToken: string }) {
    throw new Error('SalesforceClient is not implemented yet — Salesforce is next after HubSpot.');
  }
}
