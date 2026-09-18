type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function currentLevel(): number {
  const configured = (process.env.LOG_LEVEL as Level) ?? 'info';
  return LEVELS[configured] ?? LEVELS.info;
}

function log(level: Level, scope: string, message: string, meta?: unknown): void {
  if (LEVELS[level] < currentLevel()) return;
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] [${scope}] ${message}`;
  const out = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  if (meta !== undefined) {
    out(line, meta);
  } else {
    out(line);
  }
}

export function createLogger(scope: string) {
  return {
    debug: (message: string, meta?: unknown) => log('debug', scope, message, meta),
    info: (message: string, meta?: unknown) => log('info', scope, message, meta),
    warn: (message: string, meta?: unknown) => log('warn', scope, message, meta),
    error: (message: string, meta?: unknown) => log('error', scope, message, meta),
  };
}
