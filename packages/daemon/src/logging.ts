/**
 * JSON lines to stderr; suitable for container log aggregators.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(extra: LogFields): Logger;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function shouldLog(min: LogLevel, level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[min];
}

function emitLine(record: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify(record)}\n`);
}

export function createLogger(options: {
  component: string;
  minLevel?: LogLevel;
  baseFields?: LogFields;
}): Logger {
  const minLevel = options.minLevel ?? "info";
  const base = { component: options.component, ...options.baseFields };

  function log(level: LogLevel, msg: string, fields?: LogFields): void {
    if (!shouldLog(minLevel, level)) return;
    emitLine({
      ts: new Date().toISOString(),
      level,
      msg,
      ...base,
      ...fields,
    });
  }

  const self: Logger = {
    debug: (msg, fields) => log("debug", msg, fields),
    info: (msg, fields) => log("info", msg, fields),
    warn: (msg, fields) => log("warn", msg, fields),
    error: (msg, fields) => log("error", msg, fields),
    child: (extra) =>
      createLogger({
        component: options.component,
        minLevel,
        baseFields: { ...base, ...extra },
      }),
  };

  return self;
}
