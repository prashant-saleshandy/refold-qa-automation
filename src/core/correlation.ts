import { randomBytes } from 'node:crypto';

/**
 * A single identifier used to correlate one test run across SalesHandy,
 * Refold, and the destination CRM (used for filenames/logging — NOT for the
 * prospect email local-part, see buildProspectEmail below for why).
 */
export function generateRunId(prefix: string): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14); // YYYYMMDDHHMMSS
  const suffix = randomBytes(3).toString('hex');
  return `${prefix}-${stamp}-${suffix}`;
}

/**
 * A short unique token for the plus-addressed email itself. RFC 5321 caps
 * the email local-part at 64 characters and HubSpot enforces this
 * (confirmed live 2026-09-17 — a full runId embedded in the local-part,
 * e.g. "prashant+receiver+hubspot-reply-received-create-contact-<stamp>-
 * <suffix>", is ~80 chars and gets rejected with INVALID_EMAIL). Keep this
 * short; the full runId is still the correlation key everywhere else
 * (Refold execution lookup uses time-window + workflow_id, not the email).
 */
export function generateShortToken(): string {
  return `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
}

/**
 * Builds a plus-addressed prospect email off one real mailbox you control,
 * so a single inbox can send/receive/reply for every test run while each
 * run still gets a distinct, queryable email address. Pass a short token
 * (generateShortToken()), not the full runId — see its docstring for why.
 *
 * e.g. buildProspectEmail('qa.prospect@gmail.com', 'md8k3f2a')
 *   -> 'qa.prospect+md8k3f2a@gmail.com'
 */
export function buildProspectEmail(baseEmail: string, shortToken: string): string {
  const [local, domain] = baseEmail.split('@');
  if (!local || !domain) {
    throw new Error(`Invalid base email for plus-addressing: "${baseEmail}"`);
  }
  const address = `${local}+${shortToken}@${domain}`;
  if (address.split('@')[0]!.length > 64) {
    throw new Error(
      `Prospect email local-part exceeds RFC 5321's 64-char limit (HubSpot enforces this): "${address}"`,
    );
  }
  return address;
}
