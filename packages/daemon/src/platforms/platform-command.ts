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
  model: (opts) => {
    const payload: Record<string, unknown> = {};
    if (opts.session_id) {
      payload.session_id = opts.session_id;
    } else if (opts.agent_id) {
      payload.agent_id = opts.agent_id;
    }
    if (opts.model_selection !== undefined) {
      try {
        payload.model_selection = JSON.parse(opts.model_selection);
      } catch {
        payload.model_selection = opts.model_selection;
      }
    }
    return { op: "session_model", payload };
  },
  queue: (opts) => {
    const payload: Record<string, unknown> = {
      action: opts.action ?? "list",
      ...(opts.session_id ? { session_id: opts.session_id } : {}),
      ...(opts.priority ? { priority: opts.priority } : {}),
    };
    if (opts.index !== undefined) {
      payload.by = "index";
      payload.index = Number(opts.index);
    } else if (opts.range) {
      const [s, e] = opts.range.split("-").map(Number);
      payload.by = "range";
      payload.start = s;
      payload.end = e;
    } else if (opts.count !== undefined) {
      payload.by = "count";
      payload.count = Number(opts.count);
    }
    return { op: "session_queue_manage", payload };
  },
};

/** Translate a PlatformCommand to a control plane operation request. Returns null for unknown commands. */
export function translateCommandToControlOp(cmd: PlatformCommand): ControlOpRequest | null {
  const handler = COMMAND_TO_OP[cmd.name];
  return handler ? handler(cmd.options) : null;
}
