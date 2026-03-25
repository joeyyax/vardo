type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const currentLevel: number =
  LEVELS[(process.env.LOG_LEVEL as LogLevel) ?? "info"] ?? LEVELS.info;

function fmt(level: LogLevel, prefix: string, args: unknown[]): unknown[] {
  const tag = prefix ? `[${prefix}]` : "";
  const ts = new Date().toISOString();
  return [`${ts} ${level.toUpperCase()}${tag}`, ...args];
}

function createLogger(prefix = "") {
  return {
    debug: (...args: unknown[]) => {
      if (currentLevel <= LEVELS.debug) console.debug(...fmt("debug", prefix, args));
    },
    info: (...args: unknown[]) => {
      if (currentLevel <= LEVELS.info) console.log(...fmt("info", prefix, args));
    },
    warn: (...args: unknown[]) => {
      if (currentLevel <= LEVELS.warn) console.warn(...fmt("warn", prefix, args));
    },
    error: (...args: unknown[]) => {
      if (currentLevel <= LEVELS.error) console.error(...fmt("error", prefix, args));
    },
    child: (childPrefix: string) => createLogger(prefix ? `${prefix}:${childPrefix}` : childPrefix),
  };
}

export const logger = createLogger();
export type Logger = ReturnType<typeof createLogger>;
