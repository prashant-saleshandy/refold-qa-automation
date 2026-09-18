/**
 * Pipedrive client — NOT YET IMPLEMENTED.
 *
 * Pipedrive uses a simple API token (Settings > Personal preferences > API)
 * — see .env.example. Straightforward to implement once HubSpot's pattern
 * is proven; kept as a boundary placeholder for now.
 *
 * Boundary rule: this file must never import from hubspot/, salesforce/, or
 * zoho/ — see execution-plan.md §7.
 */
export class PipedriveClient {
  constructor(_config: { baseUrl: string; apiToken: string }) {
    throw new Error('PipedriveClient is not implemented yet.');
  }
}
