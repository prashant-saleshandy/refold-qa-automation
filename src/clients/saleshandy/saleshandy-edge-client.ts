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

/**
 * Outcome name -> numeric id, mirrored from edge's own
 * `src/sequence/enums/outcome.ts` (`OutcomeOptions`/`OutcomeId`). Confirmed
 * live 2026-09-18 against a real sequence's `category` field (categoryId: 2
 * === "Interested") — do NOT re-derive this by guessing; `outcomeId: 6` was
 * manually assumed to mean "Interested" earlier in testing and is actually
 * "Closed", which silently caused every outcome-gated action to skip.
 */
export const OUTCOME_NAME_TO_ID: Record<string, number> = {
  Uncategorized: 1,
  Interested: 2,
  'Not Interested': 3,
  'Meeting Booked': 4,
  'Out of Office': 5,
  Closed: 6,
  'Not Now': 7,
  'Do Not Contact': 8,
};

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
    try {
      await this.http.post(`/sequences/${sequenceId}/emails/send`, {
        sequenceProspectTaskId: queued.sequenceProspectTaskId,
        emailAccountId: queued.emailAccountId,
      });
    } catch (error) {
      // getQueuedEmail() can return a stale "still queued" entry for an
      // email that already sent moments ago (e.g. a previous force-send on
      // a --resume retrigger) — confirmed live 2026-09-24, error code 1001,
      // message "Email has already been sent". Forcing an already-sent
      // email is a no-op from the caller's point of view, not a real
      // failure — swallow just this one known case, let every other error
      // propagate.
      //
      // Confirmed live 2026-09-28: code 1001 is NOT unique to that case —
      // the sender account hitting its daily sending limit ALSO returns
      // code 1001, with message "You have reached the maximum daily
      // sending limit for this sender email, please wait for the quota
      // reset". Checking the code alone silently swallowed that too,
      // turning a real, unrecoverable failure into a no-op that left the
      // caller waiting on an email that was never going to send — must
      // check the message, not just the code.
      const data = (error as { response?: { data?: unknown } }).response?.data as { code?: number; message?: string } | undefined;
      if (data?.code === 1001 && /already\s+(been\s+)?sent/i.test(data?.message ?? '')) return;
      throw error;
    }
  }

  /**
   * Resolves the numeric `prospectId` (the global contact id, distinct from
   * the sequence-prospect join row's own id) for a prospect's email within a
   * sequence — needed by updateProspectOutcome(). Confirmed live 2026-09-18:
   * `GET /:sequenceId/contacts` returns `payload.SeqeunceProspects[]`, each
   * with a nested `.prospect.{id,email}` — `id` there is exactly the
   * `prospectId` the outcome endpoint expects.
   */
  async findProspectIdByEmail(sequenceId: number, email: string): Promise<number | null> {
    const row = await this.getContactRow(sequenceId, email);
    return row?.prospect?.id ?? null;
  }

  /**
   * Raw sequence-prospect row for one email within a sequence — used both by
   * findProspectIdByEmail() and by waitForStepCompletion() to check
   * `currentStepCompletedAt`.
   */
  private async getContactRow(
    sequenceId: number,
    email: string,
  ): Promise<{
    prospect?: { id?: number; email?: string };
    currentStepCompletedAt?: string | null;
    sequenceProspectTasks?: Array<{ id: number }>;
  } | null> {
    const { data } = await this.http.get(`/sequences/${sequenceId}/contacts`, {
      params: { search: email, pageSize: 25, pageNum: 0 },
    });
    const rows = data?.payload?.SeqeunceProspects ?? [];
    return rows.find((row: { prospect?: { email?: string } }) => row.prospect?.email?.toLowerCase() === email.toLowerCase()) ?? null;
  }

  /** The sequenceProspectTaskId for a prospect's CURRENT (already-sent) step
   * — needed to mark an email as bounced, which (unlike getQueuedEmail) only
   * exists once the email has actually sent. */
  async findSequenceProspectTaskId(sequenceId: number, email: string): Promise<number | null> {
    const row = await this.getContactRow(sequenceId, email);
    return row?.sequenceProspectTasks?.[0]?.id ?? null;
  }

  /** Marks an email as bounced via the same internal endpoint the dashboard's
   * emails-tab "Mark as bounced" action uses — the trigger for "Email is
   * Bounced in Saleshandy". Requires the email to have already sent (needs a
   * real SequenceProspectTask row), same requirement as unsubscribe/outcome. */
  async markEmailBounced(sequenceId: number, sequenceProspectTaskIds: number[]): Promise<void> {
    await this.http.patch(`/sequences/${sequenceId}/emails/status`, {
      sequenceProspectTaskIds,
      status: 'bounced',
    });
  }

  /**
   * Polls until the prospect's current step has actually completed sending
   * (`currentStepCompletedAt` populated), or the timeout elapses.
   *
   * Confirmed live 2026-09-18: edge's `updateProspectOutcome` silently skips
   * sending the Refold/webhook event entirely if no `SequenceProspectTask`
   * row yet exists for the prospect's current step (`if (!sequenceProspectTask)
   * return;` in sequence.service.ts) — no error, just a no-op. Calling
   * updateProspectOutcome() right after forcing "Send Now" races this: the
   * PATCH can return 200 and genuinely update the category, but if the send
   * hasn't actually committed yet, the outcome-change event never reaches
   * Refold and the harness times out waiting for an execution that was never
   * created. Always call this before updateProspectOutcome() for a
   * freshly-activated sequence.
   */
  async waitForStepCompletion(
    sequenceId: number,
    email: string,
    options: { timeoutMs?: number; pollIntervalMs?: number } = {},
  ): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 90_000;
    const pollIntervalMs = options.pollIntervalMs ?? 3_000;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      const row = await this.getContactRow(sequenceId, email);
      if (row?.currentStepCompletedAt) return;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error(
      `Timed out after ${timeoutMs}ms waiting for ${email}'s current step to complete sending on sequence ${sequenceId} — ` +
        `updateProspectOutcome() would silently no-op (no SequenceProspectTask yet) if called now.`,
    );
  }

  /**
   * Sets a prospect's outcome — the REAL trigger for the "Prospect Outcome
   * is updated in Saleshandy" Refold workflow. Confirmed live 2026-09-18 via
   * manual curl replay: this internal edge endpoint (used by the dashboard's
   * own outcome-change UI) reaches Refold correctly.
   *
   * Do NOT use SaleshandyClient.updateProspectOutcome (the public Open API's
   * `PATCH /sequences/update-prospect-outcome`) for this — confirmed via
   * source-code trace (see SH-20244) that it sends
   * `CobaltEvent.ProspectOutcomeUpdated`, which the internal event mapper has
   * no case for, so it never reaches Refold at all. That method is left in
   * place only as a record of the bug; it is not called anywhere anymore.
   */
  async updateProspectOutcome(params: { sequenceId: number; prospectId: number; outcomeName: string }): Promise<void> {
    const outcomeId = OUTCOME_NAME_TO_ID[params.outcomeName];
    if (outcomeId === undefined) {
      throw new Error(`Unknown outcome name "${params.outcomeName}" — expected one of: ${Object.keys(OUTCOME_NAME_TO_ID).join(', ')}`);
    }
    await this.http.patch(`/sequences/${params.sequenceId}/outcome`, {
      prospectId: params.prospectId,
      outcomeId,
    });
  }

  /** Unsubscribes prospects via the internal edge API — the trigger for
   * "Prospect is Unsubscribed in Saleshandy". Only emits the Cobalt event
   * for prospects that already have a sequence task (i.e. their email has
   * sent) — see AL-4015. */
  async unsubscribeProspects(prospectIds: number[]): Promise<void> {
    await this.http.post('/contacts/unsubscribe', { contactIds: prospectIds });
  }

  /**
   * Sets a sequence-level setting (e.g. `track-link-clicks`) via the
   * internal session-token API. A freshly created sequence defaults
   * `track-link-clicks` to "0" — confirmed live 2026-09-28: with it off,
   * SalesHandy never rewrites a sent email's `<a href>` into a
   * click-tracking URL, so "Link is Clicked in Saleshandy" can never fire.
   * Must be called BEFORE the sequence's first email sends, since the
   * rewrite happens at send time.
   *
   * NOT the public Open API: confirmed live 2026-09-28 that `PATCH
   * /sequences/:id/settings` there uses a completely different NUMERIC code
   * schema (1-13, presumably from the open-api-gateway service, not edge's
   * own string-based `SequenceSettingCode` enum) and rejects string codes
   * like "track-link-clicks" outright.
   */
  async setSequenceSetting(sequenceId: number, code: string, value: string): Promise<void> {
    await this.http.patch(`/sequences/${sequenceId}/settings`, { settings: [{ code, value }] });
  }

  /** All sequences whose title contains `search` — used to find every
   * leftover "QA ..." sequence from previous runs before a fresh one. */
  async findSequencesByTitleSearch(search: string): Promise<Array<{ id: number; title: string }>> {
    const { data } = await this.http.get('/sequences', { params: { search } });
    return data?.payload?.sequences ?? [];
  }

  /** Deletes one sequence by its numeric (edge) id. */
  async deleteSequence(sequenceId: number): Promise<void> {
    await this.http.delete(`/sequences/${sequenceId}`);
  }
}
