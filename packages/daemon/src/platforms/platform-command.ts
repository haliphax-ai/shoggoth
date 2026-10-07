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

const COMMAND_TO_OP: Record<string, (opts: Readonly<Record<string, string>>) => ControlOpRequest> =
  {
    elevate: (opts) => {
      const action = opts.action?.trim() ?? "grant";
      if (action === "revoke") {
        return {
          op: "elevation_revoke",
          payload: {
            ...(opts.grant_id ? { grant_id: opts.grant_id } : {}),
            ...(opts.session_id ? { session_id: opts.session_id } : {}),
          },
        };
      }
      // Default: grant
      const payload: Record<string, unknown> = {};
      if (opts.session_id) payload.session_id = opts.session_id;
      if (opts.duration) {
        const m = /^(\d+)(s|m|h)?$/.exec(opts.duration.trim());
        if (m) {
          const n = Number.parseInt(m[1], 10);
          const unit = m[2] ?? "s";
          const ms = unit === "h" ? n * 3600000 : unit === "m" ? n * 60000 : n * 1000;
          payload.duration_ms = ms;
        }
      }
      return { op: "elevation_grant", payload };
    },
    abort: (opts) => ({
      op: "session_abort",
      payload: opts.session_id ? { session_id: opts.session_id } : {},
    }),
    steer: (opts) => {
      const payload: Record<string, unknown> = {};
      const prompt = opts.prompt?.trim();
      if (prompt) payload.prompt = prompt;
      const sessionId = opts.session_id?.trim();
      if (sessionId) payload.session_id = sessionId;
      if (opts.delivery === "internal") payload.delivery = "internal";
      return { op: "session_steer", payload };
    },
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
      payload: opts.session_id ? { session_id: opts.session_id } : {},
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
        const raw = opts.model_selection.trim();
        const slashIdx = raw.indexOf("/");
        if (slashIdx > 0) {
          payload.model_selection = { model: raw };
        } else {
          payload.model_selection = raw;
        }
      }
      return { op: "session_model", payload };
    },
    prompt: (opts) => {
      // Primary option is the slug; every other option is a placeholder
      // parameter passed as its own name/value pair. All values are required
      // (validation happens in the daemon op against the prompt file).
      const slug = opts.slug?.trim();
      const payload: Record<string, unknown> = {};
      if (slug) payload.slug = slug;
      const params: Record<string, string> = {};
      for (const [key, value] of Object.entries(opts)) {
        if (key === "slug" || key === "session_id") continue;
        params[key] = value;
      }
      if (Object.keys(params).length > 0) payload.params = params;
      if (opts.session_id?.trim()) payload.session_id = opts.session_id.trim();
      return { op: "prompt", payload };
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
