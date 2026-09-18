import axios, { type AxiosInstance } from 'axios';
import { createLogger } from '../../core/logger.js';

const logger = createLogger('refold-client');

export interface RefoldExecutionNode {
  node_id: string;
  node_name: string;
  node_type: string;
  node_status: string;
  current_status?: string;
  attempts_made?: number;
  execution_time?: number;
  /** The actual resolved request payload for this node — e.g. for a
   * HubSpot create-contact node, the property values sent (confirmed live
   * 2026-09-17: this is where the "resolved config" actually lives, not
   * `custom_field_values` — see RefoldExecutionDetail below). */
  input_data?: unknown;
  latest_output?: unknown;
}

export interface RefoldExecutionSummary {
  _id: string;
  name: string;
  status: string;
  createdAt: string;
  completion_time?: string;
  linked_account_id: string;
  config_id?: string;
  environment?: string;
}

export interface RefoldExecutionDetail extends RefoldExecutionSummary {
  // NOTE: Refold's docs describe a `custom_field_values` field on execution
  // detail holding the resolved config — confirmed live 2026-09-17 that
  // this field does not actually exist on the response. The real resolved
  // payload lives per-node on `nodes[].input_data` instead.
  nodes?: RefoldExecutionNode[];
  associated_workflow?: { _id: string; name: string };
}

export interface RefoldConfigField {
  id: string;
  name: string;
  field_type: string;
  value?: unknown;
  options?: Array<{ name: string; value: unknown }>;
}

export interface RefoldConfigWorkflow {
  id: string;
  name: string;
  enabled: boolean;
  fields: RefoldConfigField[];
}

export interface RefoldConfig {
  slug: string;
  config_id: string;
  fields: RefoldConfigField[];
  workflows: RefoldConfigWorkflow[];
}

export interface RefoldClientConfig {
  baseUrl: string;
  linkedAccountId: string;
  /**
   * Org-level API key ("API key for your workspace" in the Refold
   * dashboard), sent as `x-api-key`. Prefixed `tk_` for test / `pk_` for
   * production — see src/config/safety-guard.ts, which asserts this is a
   * test key before any client is constructed. Doesn't expire the way a
   * linked-account session JWT does, so that's the only auth mode this
   * client supports.
   */
  apiKey: string;
  /** Hard timeout guard — a bad execution_id is known to hang forever otherwise. */
  requestTimeoutMs?: number;
}

export class RefoldClient {
  private readonly http: AxiosInstance;

  private readonly linkedAccountId: string;

  constructor(config: RefoldClientConfig) {
    this.linkedAccountId = config.linkedAccountId;
    this.http = axios.create({
      baseURL: config.baseUrl,
      timeout: config.requestTimeoutMs ?? 30_000,
      headers: {
        linked_account_id: config.linkedAccountId,
        'x-api-key': config.apiKey,
      },
    });
  }

  /**
   * Lists executions for a workflow, newest first, optionally only those
   * created after `since` (use the run's repliedAt/sentAt timestamp).
   */
  async listExecutions(params: {
    workflowId: string;
    since?: Date;
    limit?: number;
  }): Promise<RefoldExecutionSummary[]> {
    const { data } = await this.http.get('/api/v2/public/execution', {
      params: {
        workflow_id: params.workflowId,
        execution_source: 'Event',
        limit: params.limit ?? 20,
        sortAsc: false,
        ...(params.since ? { start_date: params.since.toISOString() } : {}),
      },
    });
    return (data?.docs ?? data?.data ?? []) as RefoldExecutionSummary[];
  }

  /**
   * Fetches full execution detail. Always call this with an id you got from
   * listExecutions() — a nonexistent id is documented to hang with no
   * response, so this wraps the call in its own AbortController on top of
   * the axios timeout as a second line of defense.
   */
  async getExecution(executionId: string, timeoutMs = 30_000): Promise<RefoldExecutionDetail> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const { data } = await this.http.get(`/api/v2/public/execution/${executionId}`, {
        signal: controller.signal,
      });
      return data as RefoldExecutionDetail;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Polls listExecutions() until a new execution appears for the workflow
   * created after `since`, or the timeout elapses. This is how we detect
   * that the reply you sent actually triggered the workflow.
   */
  async waitForExecution(params: {
    workflowId: string;
    since: Date;
    timeoutMs?: number;
    pollIntervalMs?: number;
  }): Promise<RefoldExecutionSummary> {
    const timeoutMs = params.timeoutMs ?? 120_000;
    const pollIntervalMs = params.pollIntervalMs ?? 5_000;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const executions = await this.listExecutions({
        workflowId: params.workflowId,
        since: params.since,
      });
      const found = executions.find((e) => new Date(e.createdAt) >= params.since);
      if (found) return found;

      logger.debug(`No execution yet for workflow ${params.workflowId}, polling again...`);
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error(
      `Timed out after ${timeoutMs}ms waiting for a Refold execution on workflow ${params.workflowId} ` +
        `(linked_account_id=${this.linkedAccountId}). Did the reply actually get sent/detected?`,
    );
  }

  /**
   * Fetches the live option list for a dynamic config field, scoped to a
   * workflow. Used to pick a real (non-stale) option value instead of
   * hardcoding one — see execution-plan.md §5.
   */
  async getConfigFieldOptions(fieldId: string, workflowId: string): Promise<unknown[]> {
    const { data } = await this.http.get(`/api/v2/public/config/field/${fieldId}`, {
      params: { workflow_id: workflowId },
    });
    return data?.options ?? [];
  }

  /**
   * Reads a linked account's live config for an app — including each
   * workflow's `enabled` flag and every field's currently-configured
   * `value`. This is the public, org-API-key-authenticated equivalent of
   * Refold's internal `/api/v2/f-sdk/slug/{slug}/config/{id}` endpoint
   * (which requires a short-lived linked-account session JWT instead) —
   * confirmed live 2026-09-17 that this one returns identical data using
   * only the stable org key. This is what the preflight check (see
   * src/core/preflight.ts) uses to confirm a workflow/action is actually
   * enabled and configured before spending time running a test against it.
   */
  async getConfig(slug: string, configId: string): Promise<RefoldConfig> {
    const { data } = await this.http.get(`/api/v2/public/slug/${slug}/config/${configId}`);
    return data as RefoldConfig;
  }
}
