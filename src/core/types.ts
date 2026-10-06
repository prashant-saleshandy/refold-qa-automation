export type CrmSlug = 'hubspot' | 'salesforce' | 'pipedrive' | 'zoho';

/**
 * One representative field-value combination for one Refold workflow action.
 * We test one valid combo per action, not the full cartesian product of
 * option lists (see execution-plan.md §5).
 */
export interface TestCase {
  /** Unique within the CRM's fixture set, e.g. "reply-received-create-contact". */
  id: string;
  crm: CrmSlug;
  /** Refold workflow id, e.g. "681368981acc0cbcd16295a9". */
  workflowId: string;
  workflowName: string;
  /** Human-readable description of the action under test. */
  action: string;
  /**
   * Expected field values, keyed by the DESTINATION CRM's own property name
   * (e.g. HubSpot's "hs_lead_status", not Refold's internal field id).
   * Confirmed live 2026-09-17: the action node's `input_data` on a Refold
   * execution is already keyed this way (there's no separate
   * `custom_field_values` field the way Refold's docs imply), and it's also
   * exactly what the CRM object's own properties are keyed by — so one set
   * of keys verifies both layers.
   */
  expectedFields: Record<string, unknown>;
}

export interface RunContext {
  runId: string;
  prospectEmail: string;
  testCase: TestCase;
  sequenceId?: string | number;
  /**
   * When SalesHandy setup started for this run — the lower bound for
   * Refold execution lookup. NOT repliedAt: the reply and the resulting
   * Refold execution can both land before verification ever runs (e.g. a
   * two-phase run where verify happens well after the reply), so gating on
   * "since repliedAt-at-verify-time" misses real executions — confirmed
   * live 2026-09-17. setupStartedAt is safe because each run gets its own
   * fresh sequence.
   */
  setupStartedAt?: string;
  sentAt?: string;
  repliedAt?: string;
  /**
   * Generic "when the trigger for this phase actually fired" timestamp —
   * used as the lower bound for the NEXT Refold execution lookup,
   * regardless of trigger mechanism. Set by `autoReply` (same moment as
   * `repliedAt`) or by `triggerOutcomeUpdate` (see
   * src/workflows/hubspot/outcome-gate-registry.ts's `TriggerType`) —
   * prefer this over `repliedAt` in new code; `repliedAt` is kept for the
   * reply-specific meaning where it's still useful on its own.
   */
  triggeredAt?: string;
  executionId?: string;
  crmObjectId?: string;
  /**
   * Plain incrementing run number (1, 2, 3, ...) identifying ONE suite run
   * — a misnomer kept for compatibility with saved run contexts (see
   * getNextRunNumber in report.ts). Shared across every phase of that run,
   * including phases run in a LATER, separate `--resume` invocation (see
   * src/core/run-context-store.ts). Set once when a fresh context is
   * created, then persisted/reloaded on resume, so
   * `test-results/<reportTimestamp>/<workflowId>/report.md` (one combined
   * report, every action/phase) stays the same top-level folder across the
   * whole run regardless of how many separate script invocations it took.
   */
  reportTimestamp?: string;
}

export interface FieldMismatch {
  field: string;
  expected: unknown;
  actual: unknown;
}

export interface VerificationResult {
  pass: boolean;
  layer: 'refold' | 'crm';
  mismatches: FieldMismatch[];
  raw?: unknown;
}


/**
 * Every CRM verifier implements this so the core runner never branches on
 * which CRM it's dealing with — see execution-plan.md §7 for the boundary
 * rule (no CRM module imports another CRM module).
 */
export interface CrmVerifier {
  crm: CrmSlug;
  /** Look up the object Refold should have created/updated for this run and
   * diff its properties against the test case's expected fields. */
  verify(context: RunContext): Promise<VerificationResult>;
}

/** One row of the final suite report — one per (crm, workflow, action). */
export interface SuiteReportRow {
  crm: CrmSlug;
  workflowId: string;
  workflowName: string;
  action: string;
  status: 'PASS' | 'FAIL' | 'SKIPPED';
  /** Why, for SKIPPED (misconfigured) or FAIL. */
  reason?: string;
  /** Default true. False for a "diff-outcome" phase row testing that an
   * action correctly does NOT fire — see PhaseActionSpec.expectFire and
   * execution-plan.md §26. Changes how PASS/FAIL should be read: for
   * `false`, PASS means "correctly stayed silent," not "ran successfully." */
  expectFire?: boolean;
  /** Links/ids proving the result — shown in the report as evidence. */
  evidence?: {
    refoldExecutionId?: string;
    crmObjectUrl?: string;
    crmObjectId?: string;
    resultFile?: string;
  };
}

/**
 * Overall label for one workflow, rolled up from its per-action rows. Named
 * so a glance at the summary table tells you both "did we actually run
 * everything" (tested vs. partially-tested vs. not-tested) and "did it
 * work" (working vs. partially-working vs. not-working) as two independent
 * axes — see computeWorkflowSummaries() in src/core/report.ts for the rule.
 */
export type WorkflowOverallStatus =
  | 'fully-tested-and-working'
  | 'fully-tested-and-not-working'
  | 'fully-tested-but-partially-working'
  | 'partially-tested-and-working'
  | 'partially-tested-and-not-working'
  | 'partially-tested-but-partially-working'
  | 'not-tested';

/** One row of the workflow-level summary table — one per (crm, workflowId). */
export interface WorkflowSummaryRow {
  crm: CrmSlug;
  workflowId: string;
  workflowName: string;
  totalActions: number;
  passed: number;
  failed: number;
  skipped: number;
  status: WorkflowOverallStatus;
  actions: SuiteReportRow[];
}
