import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { env } from '../config/env.js';
import type { RunContext } from './types.js';

/**
 * Persists the CURRENT active RunContext for one (crm, key) so a SEPARATE
 * later invocation of run-suite.ts (via --resume) can continue against the
 * same prospect/sequence/contact instead of generating a fresh one. This
 * exists because a later phase (e.g. "update") needs the exact object an
 * earlier phase (e.g. "create") just made — see execution-plan.md's
 * two-phase design — but there's no way to pause mid-script for a
 * dashboard switch when this script is invoked unattended (see §18's
 * waitForEnter fix). Splitting into two invocations, with the dashboard
 * switch happening in between, is the actual usable pattern.
 *
 * `key` is `HarnessWorkflowSpec.contextKey ?? workflowId` — plain
 * `workflowId` collides once more than one spec targets the same Refold
 * workflow (e.g. a "same-outcome" chain and a "diff-outcome" chain both
 * testing "Prospect Outcome is updated" — see execution-plan.md §26), since
 * each needs its own independent saved prospect. Always resolve `key` via
 * that fallback at the call site rather than passing `workflowId` directly.
 *
 * This is a single overwritten "current session" file, NOT a historical
 * report artifact — unlike src/core/report.ts's timestamped snapshots,
 * which are never overwritten.
 */
function contextPath(crm: string, key: string): string {
  return `${env.testResultsDir}/.active-context-${crm}-${key}.json`;
}

export async function saveRunContext(crm: string, key: string, context: RunContext): Promise<void> {
  await mkdir(env.testResultsDir, { recursive: true });
  await writeFile(contextPath(crm, key), JSON.stringify(context, null, 2), 'utf-8');
}

export async function loadRunContext(crm: string, key: string): Promise<RunContext> {
  const raw = await readFile(contextPath(crm, key), 'utf-8').catch(() => {
    throw new Error(
      `No saved run context for ${crm}/${key} at ${contextPath(crm, key)} — ` +
        `run without --resume first to create one (e.g. run phase "create"), then --resume for a later phase.`,
    );
  });
  return JSON.parse(raw) as RunContext;
}
