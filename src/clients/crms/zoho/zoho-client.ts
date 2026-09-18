/**
 * Zoho CRM client — NOT YET IMPLEMENTED.
 *
 * Zoho needs an OAuth access/refresh token pair (self-client or
 * server-based app) — see .env.example for placeholder vars.
 *
 * Boundary rule: this file must never import from hubspot/, salesforce/, or
 * pipedrive/ — see execution-plan.md §7.
 */
export class ZohoClient {
  constructor(_config: { baseUrl: string; accessToken: string }) {
    throw new Error('ZohoClient is not implemented yet.');
  }
}
