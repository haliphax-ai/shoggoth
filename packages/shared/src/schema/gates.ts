// ---------------------------------------------------------------------------
// Configurable system gates — glob tool lists applied to the AGENTS.md
// discovery gate and the re-read-required gate in addition to the internal
// builtin handlers they are already hard-wired into.
//
// Default: both lists empty => the system gates apply to configured external
// (MCP) tools only when the operator opts in.
// ---------------------------------------------------------------------------

import { z } from "zod";

const gateToolListSchema = z
  .object({
    /** Glob list of tool names (namespaced, e.g. `demo_ext-edit`) the gate applies to. */
    tools: z.array(z.string().min(1)).default([]),
  })
  .strict();

export const shoggothGatesConfigSchema = z
  .object({
    /** Glob list of tool names the AGENTS.md discovery gate applies to. */
    agentsMd: gateToolListSchema.default({ tools: [] }),
    /** Glob list of tool names the re-read-required gate applies to. */
    reRead: gateToolListSchema.default({ tools: [] }),
  })
  .strict()
  .default({ agentsMd: { tools: [] }, reRead: { tools: [] } });

export type ShoggothGatesConfig = z.infer<typeof shoggothGatesConfigSchema>;

export const DEFAULT_GATES_CONFIG: ShoggothGatesConfig = {
  agentsMd: { tools: [] },
  reRead: { tools: [] },
};
