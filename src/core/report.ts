import { mkdir, writeFile } from 'node:fs/promises';
import { env } from '../config/env.js';
import type { SuiteReportRow, WorkflowOverallStatus, WorkflowSummaryRow } from './types.js';

/**
 * Rolls per-action rows up into one row per (crm, workflowId), with a status
 * label that separately captures two questions: did we actually run every
 * action ("tested" vs. "partially-tested" vs. "not-tested" — SKIPPED rows
 * are what drag this down), and did the ones we ran actually pass ("working"
 * vs. "partially-working" vs. "not-working" — FAIL rows drag this down).
 * These are independent axes on purpose: a workflow can be fully tested and
 * fully broken, or mostly untested but 100% passing on the one action that
 * was configured.
 */
export function computeWorkflowSummaries(rows: SuiteReportRow[]): WorkflowSummaryRow[] {
  const byWorkflow = new Map<string, SuiteReportRow[]>();
  for (const row of rows) {
    const key = `${row.crm}::${row.workflowId}`;
    const bucket = byWorkflow.get(key);
    if (bucket) bucket.push(row);
    else byWorkflow.set(key, [row]);
  }

  const summaries: WorkflowSummaryRow[] = [];
  for (const actions of byWorkflow.values()) {
    const first = actions[0]!;
    const passed = actions.filter((a) => a.status === 'PASS').length;
    const failed = actions.filter((a) => a.status === 'FAIL').length;
    const skipped = actions.filter((a) => a.status === 'SKIPPED').length;
    const total = actions.length;
    const tested = passed + failed;

    let status: WorkflowOverallStatus;
    if (tested === 0) {
      status = 'not-tested';
    } else {
      const testedPrefix = tested === total ? 'fully-tested' : 'partially-tested';
      const workingSuffix = failed === 0 ? 'and-working' : passed === 0 ? 'and-not-working' : 'but-partially-working';
      status = `${testedPrefix}-${workingSuffix}` as WorkflowOverallStatus;
    }

    summaries.push({
      crm: first.crm,
      workflowId: first.workflowId,
      workflowName: first.workflowName,
      totalActions: total,
      passed,
      failed,
      skipped,
      status,
      actions,
    });
  }
  return summaries;
}

function padRight(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

/** Renders a plain-text table — no external table library, keeps the CLI dependency-free. */
function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const renderRow = (cells: string[]) => `| ${cells.map((c, i) => padRight(c, widths[i]!)).join(' | ')} |`;
  const separator = `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`;
  return [renderRow(headers), separator, ...rows.map(renderRow)].join('\n');
}

/** The top-level report requested: one row per workflow, action breakdown, overall status. */
export function printWorkflowSummaryTable(summaries: WorkflowSummaryRow[]): void {
  console.log('\n=== Workflow Summary ===\n');

  const table = renderTable(
    ['Workflow ID', 'Workflow Title', 'Actions (pass/fail/skip)', 'Status'],
    summaries.map((s) => [
      s.workflowId,
      s.workflowName,
      `${s.passed}/${s.failed}/${s.skipped} (of ${s.totalActions})`,
      s.status,
    ]),
  );
  console.log(table);
}

/** Per-action detail — kept below the summary table for evidence/debugging. */
export function printActionDetail(rows: SuiteReportRow[]): void {
  console.log('\n=== Action Detail ===\n');
  for (const row of rows) {
    console.log(`[${row.status}] ${row.crm} — ${row.workflowName} → ${row.action}`);
    if (row.reason) console.log(`  reason: ${row.reason}`);
    if (row.evidence?.refoldExecutionId) console.log(`  refold execution: ${row.evidence.refoldExecutionId}`);
    if (row.evidence?.crmObjectUrl) console.log(`  crm object: ${row.evidence.crmObjectUrl}`);
    if (row.evidence?.resultFile) console.log(`  full detail: ${row.evidence.resultFile}`);
  }

  const passed = rows.filter((r) => r.status === 'PASS').length;
  const failed = rows.filter((r) => r.status === 'FAIL').length;
  const skipped = rows.filter((r) => r.status === 'SKIPPED').length;
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped (of ${rows.length}).`);
}

export function printSuiteReport(rows: SuiteReportRow[]): void {
  const summaries = computeWorkflowSummaries(rows);
  printWorkflowSummaryTable(summaries);
  printActionDetail(rows);
}

/**
 * Writes a report snapshot to its own uniquely-timestamped file — never
 * overwrites or deletes a previous one, by construction (every call gets a
 * fresh `Date.now()` in its filename). Safe to call multiple times across
 * one run (e.g. once per phase, plus once at the end for the combined
 * result) — each call is a complete, independent artifact.
 */
export async function writeSuiteReport(rows: SuiteReportRow[], label?: string): Promise<string> {
  await mkdir(env.testResultsDir, { recursive: true });
  const suffix = label ? `${label}-` : '';
  const path = `${env.testResultsDir}/suite-report-${suffix}${Date.now()}.json`;
  const summaries = computeWorkflowSummaries(rows);
  await writeFile(path, JSON.stringify({ summaries, actions: rows }, null, 2), 'utf-8');
  return path;
}
