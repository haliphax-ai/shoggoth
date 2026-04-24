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

// ---------------------------------------------------------------------------
// Singleton / module-level access
// ---------------------------------------------------------------------------

let _root: Logger | undefined;

/** Call once at daemon startup to set the global log level. */
export function initLogger(opts?: { minLevel?: LogLevel }): Logger {
  _root = createLogger({ component: "shoggoth", minLevel: opts?.minLevel });
  return _root;
}

/**
 * Get a child logger scoped to a component. Safe to call at module level.
 *
 * Returns a lazy proxy so that module-level `const log = getLogger("x")`
 * always delegates to the current root logger. This avoids the init-order
 * bug where a child created before `initLogger()` permanently captures the
 * default "info" minLevel and silently drops debug messages.
 */
export function getLogger(component: string): Logger {
  function current(): Logger {
    if (!_root) _root = createLogger({ component: "shoggoth" });
    return _root;
  }

  function makeProxy(fields: LogFields): Logger {
    return {
      debug: (msg, f) => current().child(fields).debug(msg, f),
      info: (msg, f) => current().child(fields).info(msg, f),
      warn: (msg, f) => current().child(fields).warn(msg, f),
      error: (msg, f) => current().child(fields).error(msg, f),
      child: (extra) => makeProxy({ ...fields, ...extra }),
    };
  }

  return makeProxy({ component });
}

/** Replace the root logger (for testing). */
export function setRootLogger(logger: Logger): void {
  _root = logger;
}
