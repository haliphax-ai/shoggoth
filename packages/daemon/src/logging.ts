/**
 * Re-export logging from @shoggoth/shared so existing relative imports still work.
 */
export {
  type Logger,
  type LogLevel,
  type LogFields,
  createLogger,
  initLogger,
  getLogger,
  setRootLogger,
} from "@shoggoth/shared";
