import { mkdirSync } from "node:fs";
import { FileLogSink } from "./logging-file-sink.js";

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

let _fileSink: FileLogSink | undefined;

function emitLine(record: Record<string, unknown>): void {
  const line = `${JSON.stringify(record)}\n`;
  process.stderr.write(line);
  if (_fileSink) {
    try {
      _fileSink.enqueue(line);
    } catch {
      // The file sink must never break the logging call path.
    }
  }
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
    let cached: { root: Logger; child: Logger } | undefined;

    function resolved(): Logger {
      const root = current();
      if (cached && cached.root === root) return cached.child;
      const child = root.child(fields);
      cached = { root, child };
      return child;
    }

    return {
      debug: (msg, f) => resolved().debug(msg, f),
      info: (msg, f) => resolved().info(msg, f),
      warn: (msg, f) => resolved().warn(msg, f),
      error: (msg, f) => resolved().error(msg, f),
      child: (extra) => makeProxy({ ...fields, ...extra }),
    };
  }

  return makeProxy({ component });
}

/** Replace the root logger (for testing). */
export function setRootLogger(logger: Logger): void {
  _root = logger;
}

// ---------------------------------------------------------------------------
// Async file sink lifecycle
// ---------------------------------------------------------------------------

export interface FileLoggingInitOptions {
  /** Master switch; `false` disables the sink entirely. */
  enabled?: boolean;
  /** Directory for date-stamped log files (created if missing). */
  dir: string;
  /** Max pending queue entries. Default 10000. */
  maxQueue?: number;
  /** Rotated `.log.gz` archives to retain. Default 7. */
  maxFiles?: number;
  /** Clock injection for tests. */
  now?: () => Date;
}

function warnFileLoggingDisabled(err: unknown): void {
  try {
    process.stderr.write(
      `${JSON.stringify({
        ts: new Date().toISOString(),
        level: "warn",
        msg: "file logging disabled; continuing with stderr only",
        component: "file-log-sink",
        err: String(err),
      })}\n`,
    );
  } catch {
    // Never let the fallback warning break startup.
  }
}

/**
 * Start the async file sink alongside stderr logging. Call once at daemon
 * startup. Degrades gracefully to stderr-only (with a one-time warning) when
 * the log directory cannot be created.
 */
export function initFileLogging(opts: FileLoggingInitOptions): FileLogSink | undefined {
  if (_fileSink) {
    const previous = _fileSink;
    _fileSink = undefined;
    void previous.close();
  }
  if (opts.enabled === false) return undefined;
  try {
    mkdirSync(opts.dir, { recursive: true });
  } catch (err) {
    warnFileLoggingDisabled(err);
    return undefined;
  }
  const sink = new FileLogSink({
    dir: opts.dir,
    maxQueue: opts.maxQueue,
    maxFiles: opts.maxFiles,
    now: opts.now,
    onFatalError: (err) => {
      if (_fileSink === sink) _fileSink = undefined;
      warnFileLoggingDisabled(err);
    },
  });
  _fileSink = sink;
  return sink;
}

/** Pending queue depth and dropped-entry count of the active sink, if any. */
export function getFileLoggingStats(): { pending: number; dropped: number } | undefined {
  if (!_fileSink) return undefined;
  return { pending: _fileSink.pending, dropped: _fileSink.dropped };
}

/** Flush pending file-sink entries to disk (best effort). */
export async function flushFileLogging(): Promise<void> {
  await _fileSink?.flush();
}

/** Flush and close the file sink (daemon shutdown). */
export async function closeFileLogging(): Promise<void> {
  const sink = _fileSink;
  _fileSink = undefined;
  await sink?.close();
}
