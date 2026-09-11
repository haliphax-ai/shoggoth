import { z } from "zod";
import { contextLevelSchema, thinkingDisplaySchema, workspaceRelativePathSchema } from "./common";
import { shoggothAgentModelsOverrideSchema } from "./models";
import { hitlRiskTierSchema } from "./hitl";
import { shoggothToolRulesSchema } from "./policy";
import { mcpServerRulesSchema } from "./mcp";

// Reactions
export const shoggothReactionsConfigSchema = z.object({ globalPassthrough: z.array(z.string().min(1)).optional(), maxAgeMinutes: z.number().int().positive().optional() }).strict();
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _ShoggothReactionsConfig = z.infer<typeof shoggothReactionsConfigSchema>;

// Agent-to-Agent
export const shoggothAgentToAgentAllowSchema = z.object({ allow: z.array(z.string().min(1)).optional() }).strict();
export const shoggothAgentToAgentConfigSchema = z.object({ allow: z.array(z.string().min(1)).optional() }).strict();
export type ShoggothAgentToAgentConfig = z.infer<typeof shoggothAgentToAgentConfigSchema>;

// Session Query
export const shoggothSessionQueryAllowSchema = z.object({ allowedAgentIds: z.array(z.string().min(1)).optional() }).strict();
export const shoggothSessionQueryConfigSchema = z.object({ allowedAgentIds: z.array(z.string().min(1)).optional() }).strict();
export type ShoggothSessionQueryConfig = z.infer<typeof shoggothSessionQueryConfigSchema>;

// Subagent Spawn
export const shoggothSubagentSpawnAllowSchema = z.object({ allow: z.array(z.string().min(1)) }).strict();
export type ShoggothSubagentSpawnAllowConfig = z.infer<typeof shoggothSubagentSpawnAllowSchema>;

// Tool Discovery
export const toolDiscoveryTriggerSchema = z.object({ match: z.string().min(1), tools: z.array(z.string().min(1)) }).strict();
export const shoggothToolDiscoveryConfigSchema = z.object({ enabled: z.boolean().optional(), alwaysOn: z.array(z.string().min(1)).default(["builtin-read","builtin-write","builtin-exec","builtin-memory-search","builtin-session-query","builtin-poll","builtin-skills","builtin-show","builtin-fs","builtin-ls","builtin-fetch","builtin-kv","builtin-timer","builtin-search","builtin-replace","builtin-cd"]), triggers: z.array(toolDiscoveryTriggerSchema).optional() }).strict();
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _ShoggothToolDiscoveryConfig = z.infer<typeof shoggothToolDiscoveryConfigSchema>;
export const shoggothAgentToolDiscoveryConfigSchema = z.object({ alwaysOn: z.array(z.string().min(1)).optional(), triggers: z.array(toolDiscoveryTriggerSchema).optional(), enabled: z.boolean().optional() }).strict();
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _ShoggothAgentToolDiscoveryConfig = z.infer<typeof shoggothAgentToolDiscoveryConfigSchema>;

// Agent Entry + Config
export const shoggothAgentIdKeySchema = z.string().min(1).refine((s) => !s.includes(":"), "must not contain ':'");
export const shoggothAgentEntrySchema = z.object({
  displayName: z.string().min(1).optional(),
  emoji: z.string().min(1).optional(),
  models: shoggothAgentModelsOverrideSchema.optional(),
  platforms: z.object({ attachmentHandling: z.any() }).catchall(z.object({ routes: z.unknown().optional() }).passthrough()).optional(),
  memory: z.object({ paths: z.array(workspaceRelativePathSchema).optional() }).strict().optional(),
  agentToAgent: shoggothAgentToAgentAllowSchema.optional(),
  subagentSpawnAllow: shoggothSubagentSpawnAllowSchema.optional(),
  spawnSubagents: z.boolean().optional(),
  sessionQuery: shoggothSessionQueryAllowSchema.optional(),
  policy: z.object({ tools: shoggothToolRulesSchema.partial().optional() }).strict().optional(),
  hitl: z.object({ bypassUpTo: hitlRiskTierSchema.optional(), toolAutoApprove: z.array(z.string().min(1)).optional() }).strict().optional(),
  reactions: shoggothReactionsConfigSchema.partial().optional(),
  toolCallTimeoutMs: z.number().int().positive().optional(),
  contextLevel: contextLevelSchema.optional(),
  subagentContextLevel: contextLevelSchema.optional(),
  toolDiscovery: shoggothAgentToolDiscoveryConfigSchema.optional(),
  thinkingDisplay: thinkingDisplaySchema.optional(),
  subagentModel: z.string().min(1).optional(),
  mcp: z.object({ serverRules: mcpServerRulesSchema.optional() }).strict().optional(),
  subagentMcp: z.object({ serverRules: mcpServerRulesSchema.optional() }).strict().optional(),
}).strict();
export type ShoggothAgentEntry = z.infer<typeof shoggothAgentEntrySchema>;
export const shoggothAgentsConfigSchema = z.object({
  list: z.record(shoggothAgentIdKeySchema, shoggothAgentEntrySchema).optional(),
  contextLevel: contextLevelSchema.optional(),
  subagentContextLevel: contextLevelSchema.optional(),
  internalStreaming: z.boolean().optional(),
  subagentModel: z.string().min(1).optional(),
  subagentMcp: z.object({ serverRules: mcpServerRulesSchema.optional() }).strict().optional(),
}).strict();
export type ShoggothAgentsConfig = z.infer<typeof shoggothAgentsConfigSchema>;
