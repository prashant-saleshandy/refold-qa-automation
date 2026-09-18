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
}

export interface HarnessWorkflowSpec {
  workflowId: string;
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
