import { setRootLogger, type Logger } from "@shoggoth/shared";

const noop = () => {};
const noopLogger: Logger = {
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
  child: () => noopLogger,
};

setRootLogger(noopLogger);
