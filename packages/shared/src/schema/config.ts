import { z } from "zod";
import { LAYOUT } from "../paths";
import {
  contextLevelToolsConfigSchema,
  thinkingDisplaySchema,
  workspaceRelativePathSchema,
} from "./common";
import { shoggothModelsConfigSchema } from "./models";
import { shoggothHitlConfigSchema, DEFAULT_HITL_CONFIG } from "./hitl";
import { shoggothGatesConfigSchema, DEFAULT_GATES_CONFIG } from "./gates";
import {
  shoggothPolicyConfigSchema,
  shoggothPolicyFragmentSchema,
  DEFAULT_POLICY_CONFIG,
} from "./policy";
import {
  shoggothMemoryConfigSchema,
  shoggothMemoryEmbeddingsConfigSchema,
  DEFAULT_MEMORY_CONFIG,
} from "./memory";
import { shoggothMcpConfigSchema } from "./mcp";
import {
  shoggothAgentsConfigSchema,
  shoggothAgentToAgentConfigSchema,
  shoggothSubagentSpawnAllowSchema,
  shoggothSessionQueryConfigSchema,
  shoggothToolDiscoveryConfigSchema,
  shoggothReactionsConfigSchema,
} from "./agents";
import { externalServiceDeclarationSchema, gatewayConfigSchema } from "./services";
import { processDeclarationSchema } from "./processes";
import {
  shoggothRuntimeConfigSchema,
  shoggothMediaGenerationConfigSchema,
  shoggothPluginEntrySchema,
  shoggothSkillsConfigSchema,
  shoggothAcpxConfigSchema,
  shoggothSearxngConfigSchema,
  shoggothRetentionConfigSchema,
  shoggothPromptsConfigSchema,
  DEFAULT_SKILLS_CONFIG,
  DEFAULT_PROMPTS_CONFIG,
} from "./runtime";

export const platformCommonConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    routes: z.unknown().optional(),
    streamResponses: z.boolean().optional(),
    streamMinIntervalMs: z.number().optional(),
    appendModelTagFooter: z.boolean().optional(),
    hitlReplyInSession: z.boolean().optional(),
  })
  .passthrough();
export const attachmentHandlingModes = ["download", "inline", "hybrid"] as const;
export const attachmentHandlingSchema = z
  .object({ mode: z.enum(attachmentHandlingModes).default("download") })
  .strict()
  .optional();
export type AttachmentHandlingMode = (typeof attachmentHandlingModes)[number];
export type AttachmentHandlingConfig = z.infer<typeof attachmentHandlingSchema>;

export const statusBarConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    statusEnabled: z.boolean().optional(),
    sequenceEnabled: z.boolean().optional(),
    toolCallsEnabled: z.boolean().optional(),
    contextWindowEnabled: z.boolean().optional(),
    compactionsEnabled: z.boolean().optional(),
  })
  .strict()
  .optional();
export type StatusBarConfig = z.infer<typeof statusBarConfigSchema>;

/** Default maximum attachment size in bytes for message-tool uploads and downloads (25 MB). */
export const DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export const vaultConfigSchema = z
  .object({
    identityPath: z.string().min(1).optional(),
    secretsDirectory: z.string().min(1).optional(),
  })
  .strict()
  .optional();
export type ShoggothVaultConfig = z.infer<typeof vaultConfigSchema>;

/**
 * Async file logging sink (`builtin-logs` reads what this writes). All fields
 * optional so config fragments can override a subset; defaults live in
 * DEFAULT_LOGGING_CONFIG.
 */
export const shoggothLoggingConfigSchema = z
  .object({
    file: z
      .object({
        enabled: z.boolean().optional(),
        /** Directory for date-stamped log files (outside agent workspaces). */
        dir: z.string().min(1).optional(),
        /** Max pending queue entries; further entries are dropped and counted. */
        maxQueue: z.number().int().positive().optional(),
        /** Rotated `.log.gz` archives to retain. */
        maxFiles: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ShoggothLoggingConfig = z.infer<typeof shoggothLoggingConfigSchema>;

export const DEFAULT_LOGGING_CONFIG: ShoggothLoggingConfig = {
  file: {
    enabled: true,
    dir: LAYOUT.logDir,
    maxQueue: 10_000,
    maxFiles: 7,
  },
};

const sharedConfigFields = {
  controlSocketMode: z.number().int().optional(),
  controlSocketUid: z.number().int().nonnegative().optional(),
  controlSocketGid: z.number().int().nonnegative().optional(),
  operatorTokenPath: z.string().min(1).optional(),
  globalInstructionsPath: z.string().min(1).optional(),
  maxAttachmentBytes: z.number().int().positive().optional(),
  models: shoggothModelsConfigSchema.optional(),
  platforms: z
    .object({
      attachmentHandling: attachmentHandlingSchema,
      statusBar: statusBarConfigSchema,
    })
    .catchall(platformCommonConfigSchema)
    .optional(),
  runtime: shoggothRuntimeConfigSchema.optional(),
  agents: shoggothAgentsConfigSchema.optional(),
  agentToAgent: shoggothAgentToAgentConfigSchema.optional(),
  subagentSpawnAllow: shoggothSubagentSpawnAllowSchema.optional(),
  /**
   * Max nested subagent levels below a top-level session (depth of a top-level session = 0).
   * Default 1: only top-level sessions may spawn. `0` disables subagent spawning entirely.
   * Combined with (not a replacement for) the `subagentSpawnAllow` allowlist.
   */
  maxSpawnDepth: z.number().int().nonnegative().optional(),
  sessionQuery: shoggothSessionQueryConfigSchema.optional(),
  contextLevelTools: contextLevelToolsConfigSchema.optional(),
  processes: z.array(processDeclarationSchema).optional(),
  services: z.array(externalServiceDeclarationSchema).optional(),
  dynamicConfigDirectory: z.string().min(1).optional(),
  searxng: shoggothSearxngConfigSchema.optional(),
  toolDiscovery: shoggothToolDiscoveryConfigSchema.optional(),
  thinkingDisplay: thinkingDisplaySchema.optional(),
  mediaGeneration: shoggothMediaGenerationConfigSchema.optional(),
  gateway: gatewayConfigSchema,
  retention: shoggothRetentionConfigSchema.optional(),
  vault: vaultConfigSchema,
  logging: shoggothLoggingConfigSchema.optional(),
  gates: shoggothGatesConfigSchema.optional(),
  /** Workflow engine configuration. */
  workflow: z
    .object({
      /** Pin workflow status posts (when (re)created) on platforms that support pinning. Default: true. */
      pinStatusPost: z.boolean().optional(),
    })
    .strict()
    .optional(),
};

export const shoggothConfigFragmentSchema = z
  .object({
    ...sharedConfigFields,
    logLevel: z.enum(["debug", "info", "warn", "error"]).optional(),
    stateDbPath: z.string().min(1).optional(),
    socketPath: z.string().min(1).optional(),
    workspacesRoot: z.string().min(1).optional(),
    secretsDirectory: z.string().min(1).optional(),
    inboundMediaRoot: z.string().min(1).optional(),
    operatorDirectory: z.string().min(1).optional(),
    configDirectory: z.string().min(1).optional(),
    hitl: shoggothHitlConfigSchema.partial().optional(),
    memory: z
      .object({
        paths: z.array(workspaceRelativePathSchema).optional(),
        embeddings: shoggothMemoryEmbeddingsConfigSchema.partial().optional(),
      })
      .strict()
      .optional(),
    skills: z
      .object({
        scanRoots: z.array(z.string().min(1)).optional(),
        disabledIds: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
    plugins: z.array(shoggothPluginEntrySchema).optional(),
    reactions: shoggothReactionsConfigSchema.partial().optional(),
    mcp: shoggothMcpConfigSchema.optional(),
    acpx: shoggothAcpxConfigSchema.partial().optional(),
    fetch: z
      .object({
        allowPrivateIps: z.boolean().optional(),
        privateIpAllowlist: z.array(z.string()).optional(),
        // Path to a PEM certificate bundle file (cf. operatorTokenPath)
        caBundle: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    prompts: shoggothPromptsConfigSchema.partial().optional(),
    policy: shoggothPolicyFragmentSchema,
  })
  .strict();
export type ShoggothConfigFragment = z.infer<typeof shoggothConfigFragmentSchema>;

export const shoggothConfigSchema = z
  .object({
    ...sharedConfigFields,
    logLevel: z.enum(["debug", "info", "warn", "error"]),
    stateDbPath: z.string().min(1),
    socketPath: z.string().min(1),
    workspacesRoot: z.string().min(1),
    secretsDirectory: z.string().min(1),
    inboundMediaRoot: z.string().min(1),
    operatorDirectory: z.string().min(1),
    configDirectory: z.string(),
    hitl: shoggothHitlConfigSchema,
    memory: shoggothMemoryConfigSchema,
    skills: shoggothSkillsConfigSchema,
    plugins: z.array(shoggothPluginEntrySchema),
    reactions: shoggothReactionsConfigSchema.optional(),
    mcp: shoggothMcpConfigSchema,
    acpx: shoggothAcpxConfigSchema.optional(),
    fetch: z
      .object({
        allowPrivateIps: z.boolean().optional(),
        privateIpAllowlist: z.array(z.string()).optional(),
        // Path to a PEM certificate bundle file (cf. operatorTokenPath)
        caBundle: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    prompts: shoggothPromptsConfigSchema.optional(),
    policy: shoggothPolicyConfigSchema,
  })
  .strict();
export type ShoggothConfig = z.infer<typeof shoggothConfigSchema>;

export function defaultConfig(configDirectory: string): ShoggothConfig {
  return {
    logLevel: "info",
    stateDbPath: LAYOUT.stateDbFile,
    socketPath: LAYOUT.controlSocket,
    workspacesRoot: LAYOUT.workspacesRoot,
    secretsDirectory: LAYOUT.secretsDir,
    inboundMediaRoot: LAYOUT.inboundMediaRoot,
    operatorDirectory: LAYOUT.operatorDir,
    configDirectory,
    dynamicConfigDirectory: "/etc/shoggoth/config.d/dynamic",
    maxAttachmentBytes: DEFAULT_MAX_ATTACHMENT_BYTES,
    hitl: DEFAULT_HITL_CONFIG,
    memory: DEFAULT_MEMORY_CONFIG,
    skills: DEFAULT_SKILLS_CONFIG,
    plugins: [{ package: "@shoggoth/platform-discord" }],
    mcp: { servers: [], poolScope: "global" },
    prompts: DEFAULT_PROMPTS_CONFIG,
    policy: DEFAULT_POLICY_CONFIG,
    platforms: { discord: { enabled: true } },
    gates: DEFAULT_GATES_CONFIG,
    logging: DEFAULT_LOGGING_CONFIG,
    workflow: { pinStatusPost: true },
  };
}
