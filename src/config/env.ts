import 'dotenv/config';

/**
 * Reads a required env var, throwing a clear error naming the missing key
 * instead of letting a downstream client fail with a confusing 401/undefined.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required env var "${name}". Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

export function optionalEnv(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

export const env = {
  logLevel: optionalEnv('LOG_LEVEL', 'info'),
  testResultsDir: optionalEnv('TEST_RESULTS_DIR', './test-results'),
  refoldExecutionTimeoutMs: Number(optionalEnv('REFOLD_EXECUTION_TIMEOUT_MS', '120000')),
};
