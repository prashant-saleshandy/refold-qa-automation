import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { env } from '../config/env.js';
import type { SuiteReportRow, WorkflowOverallStatus, WorkflowSummaryRow } from './types.js';

/**
 * Plain incrementing run number (1, 2, 3, ...) — replaces the earlier
 * unix-timestamp folder naming. Persisted in a single counter file so it
 * survives across separate script invocations (e.g. a later `--resume`
 * call continuing a previous run's phases must reuse the SAME number, not
 * mint a new one — see RunContext.reportTimestamp's docstring, whose name
 * is now a misnomer but kept for compatibility with saved run contexts).
 */
async function readRunCounter(): Promise<number> {
  try {
    const raw = await readFile(`${env.testResultsDir}/.run-counter`, 'utf-8');
    return Number.parseInt(raw.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

export async function getNextRunNumber(): Promise<number> {
  await mkdir(env.testResultsDir, { recursive: true });
  const next = (await readRunCounter()) + 1;
  await writeFile(`${env.testResultsDir}/.run-counter`, String(next), 'utf-8');
  return next;
}

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
 * Best-effort plain-English explanation of what actually happened for one
 * row, for both PASS and FAIL — the "If failed, why" column has the raw
 * error; this one is meant to be readable without knowing this codebase.
 *
 * This is a GENERIC heuristic based on which check failed (Refold node
 * missing vs. CRM association missing vs. a field value mismatch) — it
 * does NOT know workflow-specific root causes the way a human
 * investigation does (e.g. execution-plan.md §19's association-gap finding
 * or §20's dealname/email field-mapping bug were found by tracing the raw
 * workflow JSON by hand, not by this function). Treat this column as a
 * solid first read, not a replacement for that kind of investigation when
 * something unexpected shows up repeatedly.
 */
function explainWhatHappened(row: SuiteReportRow): string {
  if (row.status === 'SKIPPED') {
    return `Not tested — ${row.reason ?? 'skipped'}.`;
  }

  const objectId = row.evidence?.crmObjectId;
  const idSuffix = objectId ? ` (HubSpot object id: ${objectId})` : '';

  // A "diff-outcome" phase row (expectFire: false) has inverted meaning —
  // PASS means it correctly stayed silent, not that it ran. See
  // PhaseActionSpec.expectFire's docstring / execution-plan.md §26.
  if (row.expectFire === false) {
    return row.status === 'PASS'
      ? `Correctly did NOT fire — its outcome gate didn't match the trigger, and no matching Refold node or HubSpot change was found, as expected.`
      : `Unexpectedly fired despite its outcome gate not matching the trigger — see "If failed, why" for what it did anyway.`;
  }

  if (row.status === 'PASS') {
    return `Refold ran this action with the configured values, and HubSpot's own record reflects them exactly${idSuffix}.`;
  }

  const reason = row.reason ?? '';

  // Check the more "upstream" failure modes first — a compound reason like
  // update-deal's (no Refold node AND no associated object) should explain
  // the earlier failure, not the downstream symptom of it.
  if (/no matching node found in execution/.test(reason)) {
    return (
      'Refold never produced an execution node with this action\'s expected field values — the actual ' +
      'create/update call likely never ran, possibly because an earlier lookup step (e.g. a "search for ' +
      'existing record" step) failed to find what it needed.'
    );
  }

  if (/expected "exists", got "not found"/.test(reason)) {
    return 'The contact could not be found in HubSpot at all — either the create/update call failed, or it has not finished indexing in HubSpot\'s search yet.';
  }

  if (/expected "at least one associated object", got "none found"/.test(reason)) {
    return 'The object was likely created (or updated) successfully in HubSpot, but it is not linked (associated) to the contact that triggered the workflow — it exists as a standalone record.';
  }

  if (/expected .+, got .+/.test(reason)) {
    return `The record was found, but at least one property's real value doesn't match what's configured — see the exact values in "If failed, why".`;
  }

  return 'The action failed — see the raw error in "If failed, why".';
}

/**
 * Writes ONE combined report for the whole workflow, under
 * `test-results/<runNumber>/<workflowId>/report.md` — every action from
 * every phase in one table (Action | Pass/Failed | If failed why | What
 * happened), plus a `result.json` in the same folder with the raw rows.
 * `runNumber` is a plain incrementing integer (see getNextRunNumber),
 * shared across the whole suite run — including phases run in a later
 * `--resume` invocation — so every phase's actions land in the same
 * top-level folder. Pass the FULL accumulated row set for this workflow
 * so far each time — this overwrites the file, it doesn't append, so a
 * later phase's call must include the earlier phase's rows too.
 */
export async function writeWorkflowReport(params: {
  runNumber: number | string;
  workflowId: string;
  rows: SuiteReportRow[];
}): Promise<string> {
  const { runNumber, workflowId, rows } = params;
  const dir = `${env.testResultsDir}/${runNumber}/${workflowId}`;
  await mkdir(dir, { recursive: true });

  const jsonPath = `${dir}/result.json`;
  await writeFile(jsonPath, JSON.stringify(rows, null, 2), 'utf-8');

  const workflowName = rows[0]?.workflowName ?? workflowId;
  const passed = rows.filter((r) => r.status === 'PASS').length;
  const failed = rows.filter((r) => r.status === 'FAIL').length;
  const skipped = rows.filter((r) => r.status === 'SKIPPED').length;

  const escapeCell = (s: string) => s.replace(/\|/g, '\\|');
  const tableRows = rows
    .map((r) => {
      const failedWhy = r.status === 'FAIL' || r.status === 'SKIPPED' ? escapeCell(r.reason ?? '') : '';
      const whatHappened = escapeCell(explainWhatHappened(r));
      return `| ${r.action} | ${r.status} | ${failedWhy} | ${whatHappened} |`;
    })
    .join('\n');

  const markdown = `# Run ${runNumber} — ${workflowName} (${workflowId})

**Raw JSON results:** [./result.json](./result.json)

${passed} passed, ${failed} failed, ${skipped} skipped (of ${rows.length}).

| Action | Pass/Failed | If failed, why | What happened |
| --- | --- | --- | --- |
${tableRows}
`;

  const mdPath = `${dir}/report.md`;
  await writeFile(mdPath, markdown, 'utf-8');
  return mdPath;
}
