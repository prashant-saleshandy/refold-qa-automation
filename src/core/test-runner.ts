import { TestMailboxClient } from '../clients/mailbox/test-mailbox-client.js';
import type { RefoldExecutionNode } from '../clients/refold/refold-client.js';
import { RefoldClient } from '../clients/refold/refold-client.js';
import { SaleshandyEdgeClient } from '../clients/saleshandy/saleshandy-edge-client.js';
import { SaleshandyClient } from '../clients/saleshandy/saleshandy-client.js';
import { createLogger } from './logger.js';
import type { CrmVerifier, FieldMismatch, RunContext, VerificationResult } from './types.js';

const logger = createLogger('test-runner');

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
}): Promise<void> {
  const { saleshandy, senderEmail, context, extraProspectFields } = params;
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

  logger.debug(`Creating email step on sequence ${sequence.id}...`);
  const step = await saleshandy.createEmailStep(sequence.id, {
    subject: `QA test — ${context.runId}`,
    content:
      `<p>Hi {{firstName}},</p>` +
      `<p>Automated QA email for "${testCase.workflowName} → ${testCase.action}". Reply to this email to trigger the workflow.</p>`,
  });

  logger.debug(`Importing prospect onto step ${step.id}...`);
  const { requestId } = await saleshandy.importProspectToStep(step.id, {
    'First Name': 'QA',
    'Last Name': 'Test',
    Email: context.prospectEmail,
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
 * Checks whether the sequence's first email is actually about to send soon
 * — if SalesHandy has scheduled it more than `thresholdMs` in the future
 * (confirmed live 2026-09-17: a fresh sender account's own sending-interval
 * throttle can push this out by 20+ minutes, once even to the next day),
 * forces it via the same internal "Send Now" action the dashboard uses
 * instead of waiting. Does nothing if it's already sending imminently, or
 * if it can't find the queued entry (e.g. it already sent) — never blocks
 * or throws on the happy path. See SaleshandyEdgeClient's docstring for why
 * this internal API is used only for this one narrow purpose.
 */
export async function ensurePromptSend(params: {
  edge: SaleshandyEdgeClient;
  context: RunContext;
  thresholdMs?: number;
}): Promise<void> {
  const { edge, context, thresholdMs = 60_000 } = params;
  const title = `QA ${context.runId}`;

  // Short retry: right after activation, the edge API can lag a couple of
  // seconds before the sequence/its queued email are indexed.
  let sequenceId: number | null = null;
  for (let attempt = 0; attempt < 5 && !sequenceId; attempt++) {
    sequenceId = await edge.findSequenceIdByTitle(title);
    if (!sequenceId) await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  if (!sequenceId) {
    logger.debug(`Could not find sequence "${title}" via edge API — skipping send-now check.`);
    return;
  }

  let queued = null;
  for (let attempt = 0; attempt < 5 && !queued; attempt++) {
    // eslint-disable-next-line no-await-in-loop
    queued = await edge.getQueuedEmail(sequenceId);
    if (!queued) await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  if (!queued) {
    logger.debug('No queued email found (already sent?) — skipping send-now check.');
    return;
  }

  const delayMs = queued.scheduledAt.getTime() - Date.now();
  if (delayMs <= thresholdMs) {
    logger.debug(`Email is scheduled within ${thresholdMs}ms (at ${queued.scheduledAt.toISOString()}) — letting it send normally.`);
    return;
  }

  logger.info(
    `Email scheduled for ${queued.scheduledAt.toISOString()} (${Math.round(delayMs / 60_000)} min away) — forcing Send Now.`,
  );
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
 */
function findResolvedFieldValues(
  nodes: RefoldExecutionNode[] | undefined,
  expectedFields: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const expectedKeys = Object.keys(expectedFields);
  if (expectedKeys.length === 0) return undefined;

  return nodes
    ?.map((node) => {
      const data = node.input_data;
      if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
      const additionalFields = (data as Record<string, unknown>).additional_fields;
      return {
        ...data,
        ...(typeof additionalFields === 'object' && additionalFields !== null ? additionalFields : {}),
      };
    })
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
    if (String(actual).toLowerCase() !== String(expected).toLowerCase()) {
      mismatches.push({ field, expected, actual });
    }
  }
  return { pass: mismatches.length === 0, layer: 'refold', mismatches };
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
  logger.info(`Auto-replied as ${context.prospectEmail} to ${senderEmail}.`);
}

/** One action's expected config + verifier, for a run that tests several
 * actions off a single trigger (see verifyMultiActionExecution). */
export interface PhaseActionSpec {
  action: string;
  expectedFields: Record<string, unknown>;
  verifier: CrmVerifier;
}

export interface PhaseActionResult {
  action: string;
  refold: VerificationResult;
  crm: VerificationResult;
  pass: boolean;
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
  const executionDetail = await refold.getExecution(executionSummary._id);

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

    results.push({ action: spec.action, refold: refoldResult, crm: crmResult, pass: refoldResult.pass && crmResult.pass });
  }

  return { executionId: executionSummary._id, results };
}
