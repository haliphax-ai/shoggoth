/**
 * Platform-agnostic command interface for translating operator commands
 * (e.g. slash commands, chat commands) into control plane operations.
 */

export interface PlatformCommand {
  readonly name: string;
  readonly options: Readonly<Record<string, string>>;
}

export interface ControlOpRequest {
  readonly op: string;
  readonly payload: Record<string, unknown>;
}

/** Parse a raw command name + options map into a PlatformCommand. Returns null for empty names. */
export function parsePlatformCommand(
  name: string,
  options: Record<string, string>,
): PlatformCommand | null {
  if (!name.trim()) return null;
  return { name: name.trim(), options };
}

const COMMAND_TO_OP: Record<string, (opts: Readonly<Record<string, string>>) => ControlOpRequest> = {
  abort: (opts) => ({
    op: "session_abort",
    payload: opts.session_id ? { session_id: opts.session_id } : {},
  }),
  new: (opts) => ({
    op: "session_context_new",
    payload: opts.session_id ? { session_id: opts.session_id } : {},
  }),
  reset: (opts) => ({
    op: "session_context_reset",
    payload: opts.session_id ? { session_id: opts.session_id } : {},
  }),
  compact: (opts) => ({
    op: "session_compact",
    payload: {
      ...(opts.session_id ? { session_id: opts.session_id } : {}),
      ...(opts.force === "true" ? { force: true } : {}),
    },
  }),
  status: (opts) => ({
    op: "session_context_status",
    payload: opts.session_id ? { session_id: opts.session_id } : {},
  }),
};

/** Translate a PlatformCommand to a control plane operation request. Returns null for unknown commands. */
export function translateCommandToControlOp(cmd: PlatformCommand): ControlOpRequest | null {
  const handler = COMMAND_TO_OP[cmd.name];
  return handler ? handler(cmd.options) : null;
}
