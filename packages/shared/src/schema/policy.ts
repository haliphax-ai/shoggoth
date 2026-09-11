import { z } from "zod";

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/** Per-principal allow/deny lists for tools or control ops. Deny wins; empty allow + no `*` → default-deny. */
export const shoggothToolRulesSchema = z
  .object({
    allow: z.array(z.string()),
    deny: z.array(z.string()),
    review: z.array(z.string()).default([]),
  })
  .strict();

export type ShoggothToolRules = z.infer<typeof shoggothToolRulesSchema>;

export const shoggothPolicyConfigSchema = z
  .object({
    operator: z
      .object({
        controlOps: shoggothToolRulesSchema,
        tools: shoggothToolRulesSchema,
      })
      .strict(),
    agent: z
      .object({
        controlOps: shoggothToolRulesSchema,
        tools: shoggothToolRulesSchema,
      })
      .strict(),
    auditRedaction: z
      .object({
        /** Dot paths into JSON objects (e.g. `env.API_KEY`, `headers.authorization`). */
        jsonPaths: z.array(z.string()),
        /**
         * Per-tool additional redaction paths. Keyed by tool name.
         * These are merged with jsonPaths when redacting that tool's audit entries.
         */
        toolPaths: z.record(z.string(), z.array(z.string())).optional(),
      })
      .strict(),
  })
  .strict();

export type ShoggothPolicyConfig = z.infer<typeof shoggothPolicyConfigSchema>;

/** Layered JSON fragments may supply partial policy overlays. */
export const shoggothPolicyFragmentSchema = z
  .object({
    operator: z
      .object({
        controlOps: shoggothToolRulesSchema.partial().optional(),
        tools: shoggothToolRulesSchema.partial().optional(),
      })
      .strict()
      .optional(),
    agent: z
      .object({
        controlOps: shoggothToolRulesSchema.partial().optional(),
        tools: shoggothToolRulesSchema.partial().optional(),
      })
      .strict()
      .optional(),
    auditRedaction: z
      .object({
        jsonPaths: z.array(z.string()).optional(),
        toolPaths: z.record(z.string(), z.array(z.string())).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();

export type ShoggothPolicyFragment = z.infer<typeof shoggothPolicyFragmentSchema>;

export const DEFAULT_POLICY_CONFIG: ShoggothPolicyConfig = {
  operator: {
    controlOps: {
      allow: ["*"],
      deny: [],
      review: [],
    },
    tools: { allow: ["*"], deny: [], review: [] },
  },
  agent: {
    controlOps: {
      allow: [
        "agent_ping",
        "acpx_bind_get",
        "subagent_spawn",
        "subagent_result",
        "subagent_wait",
        "session_compact",
        "session_context_status",
        "session_inspect",
        "session_list",
        "session_stats",
        "session_send",
        "session_steer",
        "session_abort",
        "session_kill",
        "config_request",
        "config_show",
        "media_generate",
        "media_generate_poll",
      ],
      deny: [],
      review: [],
    },
    tools: { allow: ["*"], deny: [], review: [] },
  },
  auditRedaction: {
    jsonPaths: ["password", "token", "apiKey", "api_key", "authorization", "secret"],
    toolPaths: {
      "builtin-vault": ["value"],
    },
  },
};