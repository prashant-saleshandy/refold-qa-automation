import axios from 'axios';
import { TestMailboxClient } from '../clients/mailbox/test-mailbox-client.js';
import { createHubspotClientFromEnv } from '../clients/crms/hubspot/hubspot-client.js';
import type { RefoldExecutionNode } from '../clients/refold/refold-client.js';
import { RefoldClient } from '../clients/refold/refold-client.js';
import { SaleshandyEdgeClient } from '../clients/saleshandy/saleshandy-edge-client.js';
import { SaleshandyClient } from '../clients/saleshandy/saleshandy-client.js';
import { createLogger } from './logger.js';
import type { CrmVerifier, FieldMismatch, RunContext, VerificationResult } from './types.js';

const logger = createLogger('test-runner');

/**
 * Wipes every leftover test artifact before a FRESH (non --resume) run —
 * both SalesHandy's side (every "QA ..." sequence from a previous run) and
 * HubSpot's side (every contact/company/deal/task/note in this dedicated
 * QA portal). Without this, a previous run's leftover HubSpot objects can
 * make a fresh run's association checks pass or fail for the wrong reason
 * (finding an OLD company/deal instead of correctly finding none) —
 * confirmed necessary in practice: every retest cycle up to 2026-09-22 was
 * done by hand-running this exact cleanup before each `run-suite.ts` call.
 *
 * "Per workflow" is aspirational, not literal: HubSpot objects carry no
 * workflow-id tag to filter by, and this portal/account is dedicated
 * entirely to this harness, so there is currently no way to clean up ONLY
 * one workflow's leftovers without wiping the whole portal. If this
 * account/portal is ever shared across multiple concurrently-tested
 * workflows, this function needs a real scoping mechanism before it's safe
 * to call automatically — until then it wipes everything, every time.
 */
export async function cleanupPreviousTestData(params: { edge?: SaleshandyEdgeClient }): Promise<void> {
  const { edge } = params;

  if (edge) {
    const sequences = await edge.findSequencesByTitleSearch('QA');
    if (sequences.length > 0) {
      logger.info(`Deleting ${sequences.length} leftover QA sequence(s) on SalesHandy...`);
      for (const seq of sequences) {
        // eslint-disable-next-line no-await-in-loop
        await edge.deleteSequence(seq.id);
      }
    }
  }

  const hubspot = createHubspotClientFromEnv();
  for (const objectType of ['tasks', 'notes', 'deals', 'companies', 'contacts']) {
    // eslint-disable-next-line no-await-in-loop
    const deleted = await hubspot.deleteAllObjects(objectType);
    if (deleted > 0) logger.info(`Deleted ${deleted} leftover HubSpot ${objectType}.`);
  }
}

/**
 * Creates the sequence (with the given sender attached), a single Email
 * step, and imports the run's uniquely-addressed prospect directly onto it
 * — all confirmed working against SalesHandy's Open API (see
 * execution-plan.md §9/§10). Does NOT start the sequence — call
 * activateSequence separately so the caller can log/inspect state first.
 */
export async function setupSaleshandySequence(params: {
  saleshandy: SaleshandyClient;
  senderEmail: string;
  context: RunContext;
  /** Extra SalesHandy prospect-field values to set on the imported prospect
   * — e.g. for testing the "Contact properties mapping v2" field-mapping
   * mechanism, see src/workflows/hubspot/prospect-field-mappings.ts. Keyed
   * by exact SalesHandy field name, same as the base First/Last Name/Email. */
  extraProspectFields?: Record<string, string>;
  /** Used to enable `track-link-clicks` before the first send — see below.
   * Optional since not every invocation has an edge session token configured;
   * only triggerLinkClick's workflow actually needs the setting. */
  edge?: SaleshandyEdgeClient;
}): Promise<void> {
  const { saleshandy, senderEmail, context, extraProspectFields, edge } = params;
  const { testCase } = context;

  context.setupStartedAt ??= new Date().toISOString();

  logger.debug(`Looking up sender account ${senderEmail}...`);
  const senderAccount = await saleshandy.findEmailAccountByEmail(senderEmail);
  if (!senderAccount) {
    throw new Error(`No connected SalesHandy email account found for sender "${senderEmail}".`);
  }

  // SalesHandy caps sequence titles at 100 chars — runId alone already
  // encodes crm + test case id + timestamp, so keep the title to just that.
  logger.debug('Creating sequence...');
  const sequence = await saleshandy.createSequence(`QA ${context.runId}`, [senderAccount.id]);
  context.sequenceId = sequence.id;

  // Must happen before the first email sends (the click-tracking rewrite
  // happens at send time) — see setSequenceSetting's docstring. Harmless for
  // every trigger type other than triggerLinkClick. sequence.id (from the
  // public API) is NOT the edge numeric id, so it needs its own lookup.
  if (edge) {
    const title = `QA ${context.runId}`;
    let edgeSequenceId: number | null = null;
    for (let attempt = 0; attempt < 5 && !edgeSequenceId; attempt++) {
      // eslint-disable-next-line no-await-in-loop
      edgeSequenceId = await edge.findSequenceIdByTitle(title);
      // eslint-disable-next-line no-await-in-loop
      if (!edgeSequenceId) await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    if (edgeSequenceId) {
      await edge.setSequenceSetting(edgeSequenceId, 'track-link-clicks', '1');
    } else {
      logger.warn(`Could not resolve edge sequenceId for "${title}" to enable track-link-clicks — link-click triggers will fail.`);
    }
  }

  logger.debug(`Creating email step on sequence ${sequence.id}...`);
  const step = await saleshandy.createEmailStep(sequence.id, {
    subject: `QA test — ${context.runId}`,
    content:
      `<p>Hi {{firstName}},</p>` +
      `<p>Automated QA email for "${testCase.workflowName} → ${testCase.action}". Reply to this email to trigger the workflow.</p>` +
      // A real link so SalesHandy rewrites it into a click-tracking URL at
      // send time — needed by triggerLinkClick(); harmless for every other
      // trigger type, so always included rather than made conditional.
      `<p><a href="https://www.saleshandy.com/">Visit our website</a></p>`,
  });

  logger.debug(`Importing prospect onto step ${step.id}...`);
  const { requestId } = await saleshandy.importProspectToStep(step.id, {
    'First Name': 'QA',
    'Last Name': 'Test',
    Email: context.prospectEmail,
    // Without this, event.body.prospect.company is empty, and the
    // "Search for company" node's HubSpot filter renders with no `value`
    // at all — a 400 ("operator EQ requires a value") — confirmed live
    // 2026-09-22, broke the whole create-company/update-company chain.
    Company: 'QA Test Co',
    // Standard prospect fields some workflow nodes reference directly
    // (e.g. update-contact's city/state/country/jobtitle, see AL-4060) —
    // without real values here, those fields resolve to nothing and get
    // silently dropped from the request, which looks identical to the
    // node just not being wired up at all.
    City: 'QA Test City',
    State: 'QA Test State',
    Country: 'QA Test Country',
    'Job Title': 'QA Test Job Title',
    ...extraProspectFields,
  });
  logger.debug(`Waiting for import ${requestId} to complete...`);
  await saleshandy.waitForImportComplete(requestId);

  logger.debug(`Activating sequence ${sequence.id}...`);
  await saleshandy.activateSequence([sequence.id]);
  logger.info(
    `Sequence ${sequence.id} created and activated — sending from ${senderEmail} to ${context.prospectEmail}.`,
  );
}

/**
 * Forces the sequence's first email to send immediately via the same
 * internal "Send Now" action the dashboard uses — unconditionally, never
 * waiting on or inferring from SalesHandy's own scheduling/throttle. Does
 * nothing only if it can't find the sequence or a queued entry (e.g. it
 * already sent) — never blocks or throws on the happy path. See
 * SaleshandyEdgeClient's docstring for why this internal API is used only
 * for this one narrow purpose.
 *
 * Confirmed live 2026-09-24: a threshold-based "only force it if it's
 * scheduled far out" check used to guard this call, but that heuristic can
 * be wrong (an email judged "imminent" can still take longer than a poll
 * timeout to actually land), and it was also only ever invoked once per
 * prospect (initial setup) — a later retrigger via --resume had no
 * force-send at all, just a bare wait on whatever SalesHandy's throttle
 * decided. Always forcing it, on every trigger, removes both gaps.
 */
export async function ensurePromptSend(params: {
  edge: SaleshandyEdgeClient;
  context: RunContext;
}): Promise<void> {
  const { edge, context } = params;
  const title = `QA ${context.runId}`;

  // Short retry: right after activation, the edge API can lag a couple of
  // seconds before the sequence/its queued email are indexed.
  let sequenceId: number | null = null;
  for (let attempt = 0; attempt < 5 && !sequenceId; attempt++) {
    sequenceId = await edge.findSequenceIdByTitle(title);
    if (!sequenceId) await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  if (!sequenceId) {
    logger.debug(`Could not find sequence "${title}" via edge API — skipping send-now.`);
    return;
  }

  let queued = null;
  for (let attempt = 0; attempt < 5 && !queued; attempt++) {
    // eslint-disable-next-line no-await-in-loop
    queued = await edge.getQueuedEmail(sequenceId);
    if (!queued) await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  if (!queued) {
    logger.debug('No queued email found (already sent?) — skipping send-now.');
    return;
  }

  logger.info(`Forcing Send Now for the queued email (was scheduled for ${queued.scheduledAt.toISOString()})...`);
  await edge.sendNow(sequenceId, queued);
}

/**
 * Finds the action node whose resolved `input_data` actually carries the
 * fields we're checking — confirmed live 2026-09-17 that this is where the
 * real payload lives (not a top-level `custom_field_values`, which doesn't
 * exist). A single execution can have more than one node of the same
 * `node_type` (e.g. a "search for contact" node runs before the "create
 * contact" node, both node_type "hubspot") — matching by node_type alone
 * would pick the wrong one, so instead pick whichever node's input_data
 * object actually contains every expected key.
 *
 * Fixed-config fields (Lead Status, Lifecycle) sit at the top level of
 * input_data; prospect-mapped fields (see prospect-field-mappings.ts) sit
 * one level down under `input_data.additional_fields` — confirmed live
 * 2026-09-17. Flatten both into one object before matching.
 *
 * A node whose action is a raw `httprequest` (e.g. Create Deal/Company after
 * being rebuilt to carry an `associations` block — see
 * refold-workflows-config's 2026-09-22 fix) has a completely different
 * `input_data` shape: `{ method, url_path, body }`, where `body` is the
 * REAL resolved payload as a JSON-encoded string (`properties` +
 * `additional_fields` inside it), not flat top-level keys at all. Confirmed
 * live 2026-09-22 — without parsing `body`, this always reports "no
 * matching node found" even when the node ran perfectly.
 */
function flattenNodeData(data: unknown): Record<string, unknown> | undefined {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  const obj = data as Record<string, unknown>;

  if (typeof obj.body === 'string') {
    try {
      const parsed = JSON.parse(obj.body) as Record<string, unknown>;
      const properties = typeof parsed.properties === 'object' && parsed.properties !== null ? parsed.properties : {};
      const additionalFields = typeof parsed.additional_fields === 'object' && parsed.additional_fields !== null ? parsed.additional_fields : {};
      return { ...properties, ...additionalFields };
    } catch {
      return undefined;
    }
  }

  const additionalFields = obj.additional_fields;
  return {
    ...obj,
    ...(typeof additionalFields === 'object' && additionalFields !== null ? additionalFields : {}),
  };
}

function findResolvedFieldValues(
  nodes: RefoldExecutionNode[] | undefined,
  expectedFields: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const expectedKeys = Object.keys(expectedFields);
  if (expectedKeys.length === 0) return undefined;

  return nodes
    ?.map((node) => flattenNodeData(node.input_data))
    .find(
      (data): data is Record<string, unknown> =>
        data !== undefined && expectedKeys.every((key) => key in data),
    );
}

/**
 * Diffs the resolved field values actually sent to the destination CRM
 * (from the matching action node's input_data) against the test case's
 * expected fields — this is what tells us Refold ran the correct config,
 * independent of whether the CRM call itself succeeded.
 */
export function verifyRefoldExecution(
  expectedFields: Record<string, unknown>,
  nodes: RefoldExecutionNode[] | undefined,
): VerificationResult {
  // Nothing declared to check (e.g. an action we don't have a confirmed
  // field-map for yet) — trivially pass this layer rather than always
  // failing on "no matching node", since there's genuinely nothing to
  // match against. The CRM-side check still has to find the real object.
  if (Object.keys(expectedFields).length === 0) {
    return { pass: true, layer: 'refold', mismatches: [] };
  }

  const resolved = findResolvedFieldValues(nodes, expectedFields);
  if (!resolved) {
    return {
      pass: false,
      layer: 'refold',
      mismatches: [
        {
          field: '(action node)',
          expected: `a node with keys: ${Object.keys(expectedFields).join(', ')}`,
          actual: 'no matching node found in execution',
        },
      ],
    };
  }

  const mismatches: FieldMismatch[] = [];
  for (const [field, expected] of Object.entries(expectedFields)) {
    const actual = resolved[field];
    if (isRelativeDayField(expected, actual)) {
      if (!relativeDayMatches(expected as number, actual as string)) {
        mismatches.push({ field, expected, actual });
      }
      continue;
    }
    if (String(actual).toLowerCase() !== String(expected).toLowerCase()) {
      mismatches.push({ field, expected, actual });
    }
  }
  return { pass: mismatches.length === 0, layer: 'refold', mismatches };
}

/**
 * Some config fields (e.g. "Closing Date (while creating)", "Due In") are
 * configured as a plain number of DAYS FROM NOW, but Refold resolves that
 * into an actual absolute date/timestamp before sending it to the CRM —
 * confirmed live 2026-09-18 (create-deal's closedate: config value `30`
 * resolved to `2026-10-18`). Comparing the raw config number against the
 * resolved date string would always mismatch, so these are detected
 * heuristically (numeric expected value + date-shaped actual string) and
 * compared as "N days from now, within a small tolerance" instead of exact
 * equality.
 */
export function isRelativeDayField(expected: unknown, actual: unknown): actual is string {
  return typeof expected === 'number' && typeof actual === 'string' && /\d{4}-\d{2}-\d{2}/.test(actual);
}

export function relativeDayMatches(expectedDays: number, actual: string, toleranceDays = 2): boolean {
  const actualDate = new Date(actual);
  if (Number.isNaN(actualDate.getTime())) return false;
  const expectedDate = new Date(Date.now() + expectedDays * 24 * 60 * 60 * 1000);
  const diffDays = Math.abs(actualDate.getTime() - expectedDate.getTime()) / (24 * 60 * 60 * 1000);
  return diffDays <= toleranceDays;
}

/**
 * Fully automates the reply step: reads the just-sent outbound email via
 * IMAP to get its Message-ID (needed for proper threading), then sends a
 * reply via SMTP as the prospect's own plus-alias — see
 * TestMailboxClient's docstring for why this only works because the test
 * mailboxes are plus-aliases of one real account you control, not a
 * generic "reply to any inbox" capability.
 */
export async function autoReply(params: {
  mailbox: TestMailboxClient;
  senderEmail: string;
  context: RunContext;
}): Promise<void> {
  const { mailbox, senderEmail, context } = params;
  const subject = `QA test — ${context.runId}`;
  if (!context.setupStartedAt) {
    throw new Error('context.setupStartedAt is not set — did setupSaleshandySequence() run first?');
  }

  logger.debug(`Waiting for outbound email "${subject}" to arrive...`);
  const sentMessage = await mailbox.waitForMessageBySubject(subject, new Date(context.setupStartedAt));

  logger.debug(`Sending automated reply from ${context.prospectEmail}...`);
  await mailbox.sendReply({
    fromAlias: context.prospectEmail,
    to: senderEmail,
    subject,
    inReplyToMessageId: sentMessage.messageId,
    text: 'Automated QA reply — triggering the reply-received workflow.',
  });

  context.repliedAt = new Date().toISOString();
  context.triggeredAt = context.repliedAt;
  logger.info(`Auto-replied as ${context.prospectEmail} to ${senderEmail}.`);
}

/**
 * Fires the trigger for "Prospect Outcome is updated in Saleshandy" (or any
 * other outcome-gated workflow) via SalesHandy's internal edge API — no
 * email/reply/IMAP wait needed, unlike autoReply. Deterministic: the exact
 * `outcomeName` sent is under our control, unlike relying on SalesHandy's
 * own reply-outcome auto-classification. See
 * src/workflows/hubspot/outcome-gate-registry.ts.
 *
 * Uses the edge API (`PATCH /sequences/{id}/outcome`), NOT
 * SaleshandyClient.updateProspectOutcome (the public Open API) — confirmed
 * via source trace that the public API's event never reaches Refold
 * (SH-20244). The edge sequenceId/prospectId are looked up by title/email
 * since they live in a different id space than the Open API's.
 */
export async function triggerOutcomeUpdate(params: {
  edge: SaleshandyEdgeClient;
  context: RunContext;
  outcomeName: string;
}): Promise<void> {
  const { edge, context, outcomeName } = params;
  if (!context.sequenceId) {
    throw new Error('context.sequenceId is not set — did setupSaleshandySequence() run first?');
  }

  const title = `QA ${context.runId}`;
  let edgeSequenceId: number | null = null;
  for (let attempt = 0; attempt < 5 && !edgeSequenceId; attempt++) {
    // eslint-disable-next-line no-await-in-loop
    edgeSequenceId = await edge.findSequenceIdByTitle(title);
    // eslint-disable-next-line no-await-in-loop
    if (!edgeSequenceId) await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  if (!edgeSequenceId) {
    throw new Error(`Could not resolve edge sequenceId for "${title}" — did setupSaleshandySequence() run first?`);
  }

  let prospectId: number | null = null;
  for (let attempt = 0; attempt < 5 && !prospectId; attempt++) {
    // eslint-disable-next-line no-await-in-loop
    prospectId = await edge.findProspectIdByEmail(edgeSequenceId, context.prospectEmail);
    // eslint-disable-next-line no-await-in-loop
    if (!prospectId) await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  if (!prospectId) {
    throw new Error(`Could not resolve prospectId for ${context.prospectEmail} on edge sequence ${edgeSequenceId}.`);
  }

  // Force the send rather than waiting on SalesHandy's own schedule/
  // throttle — see ensurePromptSend's docstring. Needed on every call, not
  // just the first: a --resume retrigger reaches this same wait with no
  // force-send of its own otherwise.
  await ensurePromptSend({ edge, context });

  // Must wait for the send to actually complete — see
  // waitForStepCompletion's docstring: calling updateProspectOutcome before
  // the SequenceProspectTask row exists makes it silently no-op (category
  // changes, but no event ever reaches Refold).
  logger.info(`Waiting for ${context.prospectEmail}'s email to finish sending before setting outcome...`);
  await edge.waitForStepCompletion(edgeSequenceId, context.prospectEmail);

  await edge.updateProspectOutcome({ sequenceId: edgeSequenceId, prospectId, outcomeName });

  context.triggeredAt = new Date().toISOString();
  logger.info(`Set outcome "${outcomeName}" for ${context.prospectEmail} (prospectId ${prospectId}) on edge sequence ${edgeSequenceId}.`);
}

/**
 * Fires "Prospect is Unsubscribed in Saleshandy" by unsubscribing the QA
 * prospect through the edge API. Like triggerOutcomeUpdate, the email must
 * have finished sending first — the Cobalt event needs a sequence task row.
 */
export async function triggerUnsubscribe(params: {
  edge: SaleshandyEdgeClient;
  context: RunContext;
}): Promise<void> {
  const { edge, context } = params;
  const title = `QA ${context.runId}`;
  let edgeSequenceId: number | null = null;
  for (let attempt = 0; attempt < 5 && !edgeSequenceId; attempt++) {
    // eslint-disable-next-line no-await-in-loop
    edgeSequenceId = await edge.findSequenceIdByTitle(title);
    // eslint-disable-next-line no-await-in-loop
    if (!edgeSequenceId) await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  if (!edgeSequenceId) throw new Error(`Could not resolve edge sequenceId for "${title}".`);

  let prospectId: number | null = null;
  for (let attempt = 0; attempt < 5 && !prospectId; attempt++) {
    // eslint-disable-next-line no-await-in-loop
    prospectId = await edge.findProspectIdByEmail(edgeSequenceId, context.prospectEmail);
    // eslint-disable-next-line no-await-in-loop
    if (!prospectId) await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  if (!prospectId) throw new Error(`Could not resolve prospectId for ${context.prospectEmail}.`);

  await ensurePromptSend({ edge, context });
  logger.info(`Waiting for ${context.prospectEmail}'s email to finish sending before unsubscribing...`);
  await edge.waitForStepCompletion(edgeSequenceId, context.prospectEmail);

  await edge.unsubscribeProspects([prospectId]);
  context.triggeredAt = new Date().toISOString();
  logger.info(`Unsubscribed ${context.prospectEmail} (prospectId ${prospectId}).`);
}

/**
 * Fires "Email is Bounced in Saleshandy" via the same internal endpoint the
 * dashboard's emails-tab "Mark as bounced" action uses
 * (SaleshandyEdgeClient.markEmailBounced) — edge fires the identical
 * CobaltEvent.EmailBounced from this one function regardless of whether the
 * bounce was detected automatically or marked manually. Needs the email to
 * have actually sent first, same requirement as outcome/unsubscribe.
 */
export async function triggerBounce(params: {
  edge: SaleshandyEdgeClient;
  context: RunContext;
}): Promise<void> {
  const { edge, context } = params;
  const title = `QA ${context.runId}`;
  let edgeSequenceId: number | null = null;
  for (let attempt = 0; attempt < 5 && !edgeSequenceId; attempt++) {
    // eslint-disable-next-line no-await-in-loop
    edgeSequenceId = await edge.findSequenceIdByTitle(title);
    // eslint-disable-next-line no-await-in-loop
    if (!edgeSequenceId) await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  if (!edgeSequenceId) throw new Error(`Could not resolve edge sequenceId for "${title}".`);

  await ensurePromptSend({ edge, context });
  logger.info(`Waiting for ${context.prospectEmail}'s email to finish sending before marking it bounced...`);
  await edge.waitForStepCompletion(edgeSequenceId, context.prospectEmail);

  let sequenceProspectTaskId: number | null = null;
  for (let attempt = 0; attempt < 5 && !sequenceProspectTaskId; attempt++) {
    // eslint-disable-next-line no-await-in-loop
    sequenceProspectTaskId = await edge.findSequenceProspectTaskId(edgeSequenceId, context.prospectEmail);
    // eslint-disable-next-line no-await-in-loop
    if (!sequenceProspectTaskId) await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  if (!sequenceProspectTaskId) throw new Error(`Could not resolve sequenceProspectTaskId for ${context.prospectEmail}.`);

  await edge.markEmailBounced(edgeSequenceId, [sequenceProspectTaskId]);
  context.triggeredAt = new Date().toISOString();
  logger.info(`Marked ${context.prospectEmail}'s email as bounced (sequenceProspectTaskId ${sequenceProspectTaskId}).`);
}

/**
 * Fires "Link is Clicked in Saleshandy" by fetching the real link SalesHandy
 * rewrote into a click-tracking URL inside the actually-delivered test
 * email, then issuing a plain unauthenticated GET to it — functionally
 * identical to a real recipient clicking the link. No internal/session API
 * exists for this event (unlike outcome/unsubscribe/bounce); this IS the
 * real trigger mechanism, not a synthetic stand-in for one.
 *
 * The click-tracking controller (email-tracker's `GET /b/:data`) schedules
 * the actual Cobalt event 2s after the request returns
 * (`setTimeout(..., 2000)`), so this waits a further 3s before returning.
 */
export async function triggerLinkClick(params: {
  edge: SaleshandyEdgeClient;
  mailbox: TestMailboxClient;
  context: RunContext;
}): Promise<void> {
  const { edge, mailbox, context } = params;
  const subject = `QA test — ${context.runId}`;
  if (!context.setupStartedAt) {
    throw new Error('context.setupStartedAt is not set — did setupSaleshandySequence() run first?');
  }

  // track-link-clicks is enabled unconditionally in setupSaleshandySequence
  // (must happen before the FIRST send, which may be forced by run-suite.ts
  // right after setup — before this function ever runs).
  await ensurePromptSend({ edge, context });

  logger.debug(`Waiting for the tracked link in "${subject}" to appear in the delivered email...`);
  const trackedLink = await mailbox.findLinkInMessage(subject, new Date(context.setupStartedAt));

  const since = new Date();
  logger.info(`Clicking tracked link: ${trackedLink}`);
  await axios.get(trackedLink, { maxRedirects: 0, validateStatus: (status) => status < 500 });

  // The click-tracking controller updates the count/fires the event 2s
  // after this request returns — give it a bit of margin before the caller
  // starts polling Refold.
  await new Promise((resolve) => setTimeout(resolve, 3_000));

  context.triggeredAt = since.toISOString();
  logger.info(`Clicked link for ${context.prospectEmail}.`);
}

/** One action's expected config + verifier, for a run that tests several
 * actions off a single trigger (see verifyMultiActionExecution). */
export interface PhaseActionSpec {
  action: string;
  expectedFields: Record<string, unknown>;
  verifier: CrmVerifier;
  /**
   * Default true. Set false for a "diff-outcome" phase testing that an
   * action correctly does NOT run because the trigger's outcome doesn't
   * match its own "Select Outcome" gate — see execution-plan.md §26.
   * `verify()` still runs normally either way (no separate "absence"
   * check needed): its normal FAIL cases — "no matching node found" or a
   * field-value mismatch — ARE the desired outcome when nothing should
   * have fired, so the final `pass` is simply inverted for expectFire:
   * false rather than requiring bespoke verification logic.
   */
  expectFire?: boolean;
}

export interface PhaseActionResult {
  action: string;
  refold: VerificationResult;
  crm: VerificationResult;
  pass: boolean;
  expectFire: boolean;
}

/**
 * Verifies MULTIPLE actions off a SINGLE Refold execution — used when
 * several actions are configured simultaneously on the workflow's
 * `ActionN` fields, so one trigger produces one execution with one node per
 * action (see execution-plan.md's two-phase create/update design). Fetches
 * the execution once, then diffs each action's own expected fields against
 * that one execution's nodes, and runs each action's own CRM verifier.
 *
 * Each CrmVerifier.verify() only reads `prospectEmail` and
 * `testCase.expectedFields` off the RunContext it's given (see
 * src/core/types.ts) — so a small per-action context is synthesized here
 * rather than requiring one TestCase per multi-action run.
 */
export async function verifyMultiActionExecution(params: {
  prospectEmail: string;
  workflowId: string;
  workflowName: string;
  since: Date;
  refold: RefoldClient;
  actions: PhaseActionSpec[];
}): Promise<{ executionId: string; results: PhaseActionResult[] }> {
  const { prospectEmail, workflowId, workflowName, since, refold, actions } = params;

  logger.info(`Waiting for a Refold execution on workflow ${workflowId}...`);
  const executionSummary = await refold.waitForExecution({ workflowId, since });
  logger.info(`Execution ${executionSummary._id} found — waiting for it to finish running...`);
  const executionDetail = await refold.waitForExecutionCompletion(executionSummary._id);

  const results: PhaseActionResult[] = [];
  for (const spec of actions) {
    const refoldResult = verifyRefoldExecution(spec.expectedFields, executionDetail.nodes);
    logger.info(
      refoldResult.pass
        ? `[${spec.action}] Refold execution matched expected config.`
        : `[${spec.action}] Refold execution config mismatch: ${JSON.stringify(refoldResult.mismatches)}`,
    );

    // eslint-disable-next-line no-await-in-loop
    const crmResult = await spec.verifier.verify({
      runId: `${executionSummary._id}-${spec.action}`,
      prospectEmail,
      testCase: {
        id: `${workflowId}-${spec.action}`,
        crm: 'hubspot',
        workflowId,
        workflowName,
        action: spec.action,
        expectedFields: spec.expectedFields,
      },
    });

    const expectFire = spec.expectFire ?? true;
    const rawPass = refoldResult.pass && crmResult.pass;
    const pass = expectFire ? rawPass : !rawPass;
    results.push({ action: spec.action, refold: refoldResult, crm: crmResult, pass, expectFire });
  }

  return { executionId: executionSummary._id, results };
}
