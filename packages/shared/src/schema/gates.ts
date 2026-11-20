// ---------------------------------------------------------------------------
// Configurable system gates — glob tool lists for the AGENTS.md discovery and
// re-read-required gates (external/MCP tools only, opt-in via operator config).

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
