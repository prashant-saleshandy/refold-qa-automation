import nodemailer, { type Transporter } from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { createLogger } from '../../core/logger.js';

const logger = createLogger('test-mailbox-client');

export interface FoundMessage {
  messageId: string;
  from: string;
  subject: string;
}

export interface TestMailboxConfig {
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  /** The account's real login (any alias/plus-address of the same Google
   * account works for IMAP/SMTP auth — the mailbox is shared). */
  username: string;
  /** App password — works across all plus-aliases of the same account. */
  password: string;
}

/**
 * Drives one real mailbox end-to-end for reply automation: read the
 * outbound test email via IMAP to get its Message-ID (for threading), then
 * send a properly-threaded reply via SMTP as any plus-alias of that same
 * account. This is what lets the harness fully close the loop without a
 * human replying manually — see execution-plan.md §9.
 *
 * Only works because the CSV of test mailboxes you provided are all
 * plus-aliases of one real Gmail account sharing one app password — this
 * is NOT a generic "read anyone's inbox" capability.
 */
export class TestMailboxClient {
  private readonly config: TestMailboxConfig;

  private readonly transporter: Transporter;

  constructor(config: TestMailboxConfig) {
    this.config = config;
    this.transporter = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: true,
      auth: { user: config.username, pass: config.password },
    });
  }

  /**
   * Polls the IMAP inbox for a message with the given exact subject,
   * returning its Message-ID (needed for In-Reply-To/References threading)
   * once found.
   *
   * Confirmed live 2026-09-17: IMAP's SEARCH HEADER/TEXT defaults to a
   * US-ASCII charset and silently returns zero matches for a subject
   * containing a non-ASCII character (an em dash, in our case) — even
   * though the message demonstrably exists (verified by listing recent
   * messages directly). Filtering in JS on the fetched envelope, rather
   * than relying on IMAP-side header search, sidesteps that entirely.
   *
   * This also matters because the mailbox itself is a **shared, very
   * high-volume warmup pool** (~90k messages, constant unrelated traffic
   * across many plus-aliases) — `since` narrows the fetch window so we're
   * not scanning that whole history every poll.
   *
   * Default timeout is long (25 min) because the sender account has its own
   * min/max sending-interval throttle (confirmed live 2026-09-17: a
   * `max-interval` of 1200s in the account's settings) — running several
   * test sequences from the same sender in quick succession can genuinely
   * delay the next send by up to 20 minutes. This is a real SalesHandy
   * account setting, not something the harness can bypass — see
   * execution-plan.md §9.
   */
  async waitForMessageBySubject(
    subject: string,
    since: Date,
    options: { timeoutMs?: number; pollIntervalMs?: number } = {},
  ): Promise<FoundMessage> {
    const timeoutMs = options.timeoutMs ?? 25 * 60_000;
    const pollIntervalMs = options.pollIntervalMs ?? 10_000;
    const deadline = Date.now() + timeoutMs;

    const newClient = () =>
      new ImapFlow({
        host: this.config.imapHost,
        port: this.config.imapPort,
        secure: true,
        auth: { user: this.config.username, pass: this.config.password },
        logger: false,
      });

    // Confirmed live 2026-09-23: this environment sees genuinely
    // intermittent ETIMEDOUT/ENETUNREACH connecting to Gmail's IMAP host —
    // not a persistent block (the exact same address succeeds moments
    // later), so a short retry clears it reliably without masking a real,
    // persistent connectivity problem (still throws after all attempts).
    // ImapFlow instances can't be reused after a failed connect() — confirmed
    // live 2026-09-23 ("Can not re-use ImapFlow instance") — a fresh
    // instance is required per attempt, not just a retried connect() call.
    let client = newClient();
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await client.connect();
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        logger.warn(`IMAP connect attempt ${attempt}/3 failed (${(error as Error).message || (error as Error).name}) — retrying...`);
        client = newClient();
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
    }
    if (lastError) throw lastError;
    try {
      while (Date.now() < deadline) {
        const lock = await client.getMailboxLock('INBOX');
        try {
          for await (const message of client.fetch({ since }, { envelope: true })) {
            if (message.envelope?.subject === subject) {
              const messageId = message.envelope.messageId;
              if (!messageId) {
                throw new Error(`Found message with subject "${subject}" but it has no Message-ID header.`);
              }
              logger.info(`Found message "${subject}" — Message-ID: ${messageId}`);
              return {
                messageId,
                from: message.envelope.from?.[0]?.address ?? '',
                subject,
              };
            }
          }
        } finally {
          lock.release();
        }
        logger.debug(`Message "${subject}" not in inbox yet, polling again...`);
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
    } finally {
      await client.logout().catch(() => undefined);
    }

    throw new Error(`Timed out after ${timeoutMs}ms waiting for a message with subject "${subject}".`);
  }

  /**
   * Polls the IMAP inbox for a message with the given exact subject, then
   * returns the FIRST link found in its HTML body — SalesHandy rewrites any
   * `<a href>` in a sent email's body into its own click-tracking redirect
   * URL at send time, so this is the real, tracked URL a recipient would
   * actually click. Used as "Link is Clicked in Saleshandy"'s trigger: an
   * unauthenticated GET to this exact URL is functionally identical to a
   * real recipient clicking the link — no internal API is involved.
   */
  async findLinkInMessage(
    subject: string,
    since: Date,
    options: { timeoutMs?: number; pollIntervalMs?: number } = {},
  ): Promise<string> {
    const timeoutMs = options.timeoutMs ?? 25 * 60_000;
    const pollIntervalMs = options.pollIntervalMs ?? 10_000;
    const deadline = Date.now() + timeoutMs;

    const newClient = () =>
      new ImapFlow({
        host: this.config.imapHost,
        port: this.config.imapPort,
        secure: true,
        auth: { user: this.config.username, pass: this.config.password },
        logger: false,
      });

    let client = newClient();
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await client.connect();
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        logger.warn(`IMAP connect attempt ${attempt}/3 failed (${(error as Error).message || (error as Error).name}) — retrying...`);
        client = newClient();
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
    }
    if (lastError) throw lastError;
    try {
      while (Date.now() < deadline) {
        const lock = await client.getMailboxLock('INBOX');
        try {
          for await (const message of client.fetch({ since }, { envelope: true, source: true })) {
            if (message.envelope?.subject === subject && message.source) {
              const parsed = await simpleParser(message.source);
              const html = typeof parsed.html === 'string' ? parsed.html : parsed.textAsHtml;
              const match = html?.match(/href="([^"]+)"/);
              if (!match?.[1]) {
                throw new Error(`Found message with subject "${subject}" but its body has no <a href> link.`);
              }
              const link = match[1].replace(/&amp;/g, '&');
              logger.info(`Found tracked link in message "${subject}": ${link}`);
              return link;
            }
          }
        } finally {
          lock.release();
        }
        logger.debug(`Message "${subject}" not in inbox yet, polling again...`);
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
    } finally {
      await client.logout().catch(() => undefined);
    }

    throw new Error(`Timed out after ${timeoutMs}ms waiting for a message with subject "${subject}".`);
  }

  /**
   * Sends a reply threaded to the given original message, from one of the
   * account's plus-aliases.
   */
  async sendReply(params: {
    fromAlias: string;
    to: string;
    subject: string;
    inReplyToMessageId: string;
    text: string;
  }): Promise<void> {
    const replySubject = params.subject.startsWith('Re:') ? params.subject : `Re: ${params.subject}`;
    await this.transporter.sendMail({
      from: params.fromAlias,
      to: params.to,
      subject: replySubject,
      text: params.text,
      inReplyTo: params.inReplyToMessageId,
      references: [params.inReplyToMessageId],
    });
    logger.info(`Sent reply from ${params.fromAlias} to ${params.to}, in-reply-to ${params.inReplyToMessageId}.`);
  }
}
