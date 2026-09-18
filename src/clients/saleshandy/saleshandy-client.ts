import axios, { type AxiosInstance } from 'axios';

/**
 * SalesHandy Open API client — https://open-api.saleshandy.com/v1
 *
 * Endpoints confirmed against the live OpenAPI spec (fetched from
 * SalesHandy's own doc-generation service) on 2026-09-17. Auth is a single
 * `x-api-key` header — the key is tied to one SalesHandy account/tenant
 * (pyxis, in our case), so hitting this shared gateway with a pyxis-scoped
 * key only ever touches pyxis data. There is no separate "test" hostname to
 * assert against the way Refold has one — the safety boundary here is
 * entirely "this key belongs to the pyxis account", so double-check that
 * before ever pointing SALESHANDY_API_TOKEN at a different key.
 */

export interface EmailAccount {
  id: string;
  fromName: string;
  fromEmail: string;
  status: number;
  isDefault: boolean;
}

export interface CreatedSequence {
  id: string;
  title: string;
}

export interface CreatedStep {
  id: string;
  number: number;
}

export class SaleshandyClient {
  private readonly http: AxiosInstance;

  constructor(config: { baseUrl: string; apiKey: string }) {
    this.http = axios.create({
      baseURL: config.baseUrl,
      timeout: 30_000,
      headers: { 'x-api-key': config.apiKey },
    });

    // The Open API's rate limit is fairly tight and gets hit during normal
    // multi-step test setup (create sequence -> step -> import -> poll ->
    // activate). Confirmed live 2026-09-17: comes back as HTTP 400 with
    // { code: 40000, message: "Rate Limit exceeded" }, not a 429.
    this.http.interceptors.response.use(undefined, async (error) => {
      const isRateLimit = error.response?.data?.code === 40000;
      const attempt = error.config.__rateLimitRetries ?? 0;
      if (isRateLimit && attempt < 5) {
        const delayMs = 5_000 * (attempt + 1);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        error.config.__rateLimitRetries = attempt + 1;
        return this.http.request(error.config);
      }
      throw error;
    });
  }

  /** Finds the sender email account whose fromEmail matches (case-insensitive). */
  async findEmailAccountByEmail(email: string): Promise<EmailAccount | null> {
    const { data } = await this.http.post('/email-accounts', { search: email, pageSize: 25 });
    const match = (data?.payload?.emails ?? []).find(
      (account: EmailAccount) => account.fromEmail.toLowerCase() === email.toLowerCase(),
    );
    return match ?? null;
  }

  /** Creates a sequence with the given sender account(s) attached. */
  async createSequence(title: string, emailAccountIds: string[]): Promise<CreatedSequence> {
    const { data } = await this.http.post('/sequences', { title, emailAccountIds });
    // Confirmed live 2026-09-17: the real field is payload.sequenceId, not
    // payload.id as the published OpenAPI example shows.
    return { id: data.payload.sequenceId, title: data.payload.title };
  }

  /** Creates the single Email step used to send the trigger email for a test run. */
  async createEmailStep(
    sequenceId: string,
    variant: { subject: string; content: string },
    absoluteDays = 1,
  ): Promise<CreatedStep> {
    const { data } = await this.http.post(`/sequences/${sequenceId}/steps`, {
      // The OpenAPI schema documents `type` as a string enum ("Email", ...)
      // but the live gateway rejects that and expects the numeric code
      // instead (1 = Email, confirmed by the response schema's `type`
      // field, which is numeric) — confirmed live 2026-09-17.
      type: 1,
      absoluteDays,
      variants: [{ payload: variant }],
    });
    // Confirmed live 2026-09-17: real fields are payload.id/payload.number,
    // not top-level id/number as the published OpenAPI example shows.
    return { id: data.payload.id, number: data.payload.number };
  }

  /**
   * Imports one prospect directly onto a step (creates the contact and
   * attaches it in one call). Returns a requestId — import is async, poll
   * waitForImportComplete() with it.
   */
  async importProspectToStep(
    stepId: string,
    prospect: Record<string, string>,
  ): Promise<{ requestId: string }> {
    const { data } = await this.http.post('/sequences/prospects/import-with-field-name', {
      prospectList: [prospect],
      stepId,
      conflictAction: 'upsert',
      // Documented as optional, but the live gateway 400s without it.
      verifyProspects: false,
    });
    return { requestId: data.payload.requestId };
  }

  async waitForImportComplete(requestId: string, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    // A few seconds' initial delay + a slower poll interval — the Open API
    // has a fairly tight rate limit, hit it during testing at 3s intervals.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    while (Date.now() < deadline) {
      const { data } = await this.http.get(`/prospects/import-status/${requestId}`);
      // Confirmed live 2026-09-17: nested under payload, not top-level as
      // the published OpenAPI example shows.
      if (data.payload?.isCompleted) return;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 8_000));
    }
    throw new Error(`Prospect import ${requestId} did not complete within ${timeoutMs}ms.`);
  }

  /** Activates (starts) one or more sequences. */
  async activateSequence(sequenceIds: string[]): Promise<void> {
    await this.http.post('/sequences/status', { sequenceIds, status: 'resume' });
  }

  /**
   * NOT YET IMPLEMENTED — confirming "email sent" / "reply received" against
   * a sequence programmatically needs `/v1/unified-inbox/emails`, but that
   * endpoint requires an `owners` (user id) filter and there's no confirmed
   * "current user" endpoint in the Open API to resolve it yet. Needs a live
   * call to verify before wiring this up — don't guess at the shape here,
   * a wrong guess would fail silently. Manual confirmation (operator
   * presses Enter) remains the source of truth for now — see
   * execution-plan.md §9.
   */
}
