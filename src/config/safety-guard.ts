/**
 * Hard-fails the harness before it makes a single network call if anything
 * points at Refold's production environment.
 *
 * We NEVER touch (saleshandy prod + refold production) — only
 * (saleshandy pyxis + refold test + each CRM's personal/test account) is
 * allowed. Per Refold's docs, org API keys are prefixed `tk_` for test and
 * `pk_` for production/live — that prefix is the one machine-checkable
 * signal we have, so we assert on it rather than trusting a human to always
 * paste the right key.
 *
 * SalesHandy has no equivalent prefix to check — its safety boundary is
 * entirely "this x-api-key belongs to the pyxis account", which is not
 * something the harness can verify from the key string alone. That's a
 * standing manual responsibility, not a code guarantee — see
 * knowledge_base/execution-plan.md §10.
 */
export function assertRefoldTestEnvironment(apiKey: string): void {
  if (apiKey.startsWith('pk')) {
    throw new Error(
      'REFOLD_API_KEY looks like a PRODUCTION key (starts with "pk"). ' +
        'This harness must only ever run against Refold\'s TEST environment (keys starting with "tk"). Refusing to proceed.',
    );
  }
  if (!apiKey.startsWith('tk')) {
    throw new Error(
      `REFOLD_API_KEY has an unrecognized prefix (expected "tk" for test). Got: "${apiKey.slice(0, 4)}...". ` +
        'Refusing to proceed without a confirmed test-environment key.',
    );
  }
}
