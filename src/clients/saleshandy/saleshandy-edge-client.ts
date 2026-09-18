import axios, { type AxiosInstance } from 'axios';

/**
 * SalesHandy's internal "edge" API (pyxis.lifeisgoodforlearner.com/api/edge)
 * — session-JWT authenticated, NOT the public Open API. Used for exactly
 * one narrow purpose: checking whether a just-activated sequence's first
 * email is genuinely about to send or has been scheduled far in the future
 * by the account's sending-interval throttle, and forcing it via the
 * dashboard's "Send Now" action if so.
 *
 * This is intentionally minimal — do not add unrelated edge-API calls here
 * without deliberately deciding to depend on more internal, undocumented
 * surface. Confirmed live 2026-09-17 (found via the dashboard's own network
 * tab, explicitly provided for this purpose) — see execution-plan.md §9.
 */

export interface QueuedEmail {
  sequenceProspectTaskId: number;
  emailAccountId: number;
  /** When SalesHandy currently has this scheduled to send. */
  scheduledAt: Date;
}

export class SaleshandyEdgeClient {
  private readonly http: AxiosInstance;

  constructor(config: { baseUrl: string; sessionToken: string }) {
    this.http = axios.create({
      baseURL: config.baseUrl,
      timeout: 30_000,
      headers: { Authorization: `Bearer ${config.sessionToken}` },
    });
  }

  /** Finds a sequence by its exact title (our QA sequences are named
   * uniquely per run — see test-runner.ts). Returns the numeric id the
   * edge API uses (distinct from the Open API's hashed ids). */
  async findSequenceIdByTitle(title: string): Promise<number | null> {
    const { data } = await this.http.get('/sequences', { params: { search: title } });
    const match = (data?.payload?.sequences ?? []).find((s: { title: string }) => s.title === title);
    return match?.id ?? null;
  }

  /** The single queued/upcoming email for a freshly-created one-prospect QA
   * sequence, or null if there isn't one (e.g. it already sent). */
  async getQueuedEmail(sequenceId: number): Promise<QueuedEmail | null> {
    const { data } = await this.http.get(`/sequences/${sequenceId}/emails`);
    const email = data?.payload?.emails?.[0];
    if (!email) return null;
    return {
      sequenceProspectTaskId: email.id,
      emailAccountId: email.emailAccountId?.emailAccountId,
      scheduledAt: new Date(email.time?.value),
    };
  }

  /** Forces a queued email to send immediately, bypassing the sending
   * account's interval throttle — the same action as the dashboard's
   * "Send Now" button. */
  async sendNow(sequenceId: number, queued: QueuedEmail): Promise<void> {
    await this.http.post(`/sequences/${sequenceId}/emails/send`, {
      sequenceProspectTaskId: queued.sequenceProspectTaskId,
      emailAccountId: queued.emailAccountId,
    });
  }
}
