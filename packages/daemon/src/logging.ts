/**
 * Re-export logging from @shoggoth/shared so existing relative imports still work.
 */
export {
  type Logger,
  type LogLevel,
  type LogFields,
  type FileLoggingInitOptions,
  createLogger,
  initLogger,
  getLogger,
  setRootLogger,
  initFileLogging,
  flushFileLogging,
  closeFileLogging,
  getFileLoggingStats,
  FileLogSink,
  type FileLogSinkOptions,
  logFileNameForDate,
  logArchiveNameForDate,
} from "@shoggoth/shared";
