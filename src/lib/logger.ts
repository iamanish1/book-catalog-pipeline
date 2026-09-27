/** Minimal structured JSON logger (one JSON object per line on stderr). */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;
type LevelName = keyof typeof LEVELS;
type Level = Exclude<LevelName, 'silent'>;

function initialThreshold(): number {
  if (process.env.VITEST && !process.env.LOG_LEVEL) return LEVELS.silent;
  const name = (process.env.LOG_LEVEL ?? 'info') as LevelName;
  return LEVELS[name] ?? LEVELS.info;
}

let threshold = initialThreshold();

export function setLogLevel(level: LevelName): void {
  threshold = LEVELS[level] ?? LEVELS.info;
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }) + '\n');
}

export const log = {
  debug: (msg: string, f?: Record<string, unknown>) => emit('debug', msg, f),
  info: (msg: string, f?: Record<string, unknown>) => emit('info', msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => emit('warn', msg, f),
  error: (msg: string, f?: Record<string, unknown>) => emit('error', msg, f),
};
