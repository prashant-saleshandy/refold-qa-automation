import { readFile } from 'node:fs/promises';
import type { CrmSlug } from './types.js';

export interface HarnessPhase {
  /** Free-text label, e.g. "create" or "update" — shown in logs/reports. */
  name: string;
  /** Action codes tested TOGETHER, off one shared trigger — see
   * scripts/run-suite.ts and execution-plan.md's two-phase design. All
   * actions in one phase must be selected simultaneously on the workflow's
   * ActionN fields for that phase's single run. */
  actions: string[];
  /**
   * Default `'same-outcome'` — every action in the phase must be gated to
   * the identical "Select Outcome" value (or have no gate at all), and the
   * harness fires that one shared outcome. `'diff-outcome'` is the opposite
   * scenario: actions are deliberately gated to DIFFERENT outcomes, and the
   * harness fires just one of them (see `triggerOutcome`), expecting
   * actions gated to a different outcome to correctly NOT fire. Only
   * meaningful for outcome-gated workflows (see outcome-gate-registry.ts) —
   * ignored otherwise. See execution-plan.md §26.
   */
  mode?: 'same-outcome' | 'diff-outcome';
  /**
   * Which outcome to actually fire, for `mode: 'diff-outcome'`. If omitted,
   * defaults to whichever outcome the phase's `create-contact` or
   * `update-contact` action is configured with (the "anchor" action other
   * actions' object lookups depend on).
   */
  triggerOutcome?: string;
}

export interface HarnessWorkflowSpec {
  workflowId: string;
  /**
   * Local opt-out, independent of Refold's own dashboard `enabled` flag.
   * Defaults to `true` when omitted. Set to `false` to stop the harness
   * from touching a workflow you're done testing for now, WITHOUT deleting
   * its config (keeps the field maps / phase declarations around for when
   * you come back to it) and WITHOUT depending on the live dashboard state
   * staying disabled — even if someone re-enables it on Refold's side for
   * an unrelated reason, this keeps the harness from picking it back up
   * until you deliberately flip this back to `true`. See
   * execution-plan.md §25.
   */
  active?: boolean;
  /**
   * Distinguishes this spec's SAVED CONTEXT (see run-context-store.ts) from
   * any other spec targeting the SAME Refold workflowId — needed once more
   * than one independent test chain exists for one workflow (e.g. a
   * same-outcome chain and a diff-outcome chain both testing "Prospect
   * Outcome is updated", each needing its OWN fresh prospect — see
   * execution-plan.md §26). Defaults to `workflowId` when omitted, which is
   * only safe when exactly one spec targets that workflowId.
   */
  contextKey?: string;
  /** Ordered phases tested together (multiple actions per execution)
   * against ONE shared prospect across the whole workflow, each phase
   * triggered by its own reply to the same email thread — see
   * scripts/run-suite.ts and execution-plan.md's two-phase design. This is
   * the only way workflows/actions are declared; testing one action in
   * isolation is just a workflow with a single phase containing one action. */
  phases: HarnessPhase[];
}

export type HarnessConfig = {
  workflows: Partial<Record<CrmSlug, HarnessWorkflowSpec[]>>;
};

/**
 * Loads harness.config.json — the single place you declare which
 * workflow/action combinations to run, per CRM. See
 * knowledge_base/execution-plan.md §11.
 */
export async function loadHarnessConfig(path = 'harness.config.json'): Promise<HarnessConfig> {
  const raw = await readFile(path, 'utf-8');
  return JSON.parse(raw) as HarnessConfig;
}
