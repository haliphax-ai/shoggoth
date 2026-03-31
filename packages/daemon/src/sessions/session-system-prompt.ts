import { existsSync, readFileSync, realpathSync } from "node:fs";
import { hostname } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import {
  MESSAGING_FEATURE,
  messagingCapabilitiesHasFeature,
  type MessagingAdapterCapabilities,
} from "@shoggoth/messaging";
import {
  LAYOUT,
  OPERATOR_GLOBAL_INSTRUCTIONS_BASENAME,
  resolveEffectiveMemoryForSession,
  resolveEffectiveModelsConfig,
  type ShoggothConfig,
} from "@shoggoth/shared";
import type Database from "better-sqlite3";
import { daemonPrompt } from "../prompts/load-prompts";
import { getSessionStats } from "./session-stats-store";

/** Max bytes read per workspace template file (UTF-8). */
const DEFAULT_MAX_BYTES_PER_FILE = 8192;

/** Max combined UTF-8 bytes for all template file payloads (excluding delimiter lines). */
const DEFAULT_MAX_TOTAL_TEMPLATE_BYTES = 24576;

/** Baked into the container image (`Dockerfile`); same tree as the repo `docs/` directory. */
const SHOGGOTH_REFERENCE_DOCS_DIR = "/app/docs";

/**
 * Workspace-relative basenames only (allowlist). Order follows OpenClaw bootstrap file order.
 * Operator global instructions are **not** listed here — they load from `GLOBAL.md` under the
 * configured operator directory (gateway-only, not workspace-readable).
 */
/** Basenames injected into the system prompt when present under the session workspace (OpenClaw order). */
export const WORKSPACE_TEMPLATE_FILES = [
  "AGENTS.md",
  "SOUL.md",
  "TOOLS.md",
  "IDENTITY.md",
  "USER.md",
  "HEARTBEAT.md",
  "BOOTSTRAP.md",
  "MEMORY.md",
] as const;

export interface BuildSessionSystemContextInput {
  readonly workspacePath: string | undefined;
  readonly config?: ShoggothConfig;
  readonly env?: NodeJS.ProcessEnv;
  /** Session id for the runtime line (e.g. Discord-bound session). */
  readonly sessionId?: string;
  /** Internal context segment UUID (`sessions.context_segment_id`; `new` / `reset` on Discord). */
  readonly contextSegmentId?: string;
  /** Delivery surface id from the session URN (`agent:…:<platform>:…`), when known. */
  readonly channel?: string;
  /** When set, core prompt sections use transport {@link MessagingAdapterCapabilities.features}. */
  readonly messagingCapabilities?: MessagingAdapterCapabilities;
  /** MCP + built-in tool names exposed to the model for this turn (e.g. `builtin.read`). */
  readonly toolNames?: readonly string[];
  /** Optional sandbox identity for the workspace section. */
  readonly sandbox?: {
    readonly runtimeUid?: number;
    readonly runtimeGid?: number;
  };
  /** Optional state database for session stats lookup. */
  readonly stateDb?: Database.Database;
  /** Current transcript messages for estimating this turn's token usage. */
  readonly transcriptMessages?: readonly { role: string; content: string | null }[];
}

function isPathInsideResolvedRoot(rootReal: string, resolvedTarget: string): boolean {
  const base = resolve(rootReal);
  const target = resolve(resolvedTarget);
  const prefix = base.endsWith(sep) ? base : base + sep;
  return target === base || target.startsWith(prefix);
}

/**
 * Reads up to `maxBytes` UTF-8 bytes from `rootRaw/name` only if the real path stays under the
 * resolved workspace directory (blocks `..` and symlink escapes).
 */
function safeReadWorkspaceTemplate(
  rootRaw: string,
  fileName: (typeof WORKSPACE_TEMPLATE_FILES)[number],
  maxBytes: number,
): string | undefined {
  if (maxBytes <= 0) return undefined;

  let rootReal: string;
  try {
    rootReal = realpathSync(resolve(rootRaw.trim()));
  } catch {
    return undefined;
  }

  const candidate = resolve(join(rootReal, fileName));
  if (!existsSync(candidate)) return undefined;

  let resolvedFile: string;
  try {
    resolvedFile = realpathSync(candidate);
  } catch {
    return undefined;
  }

  if (!isPathInsideResolvedRoot(rootReal, resolvedFile)) return undefined;

  try {
    const buf = readFileSync(resolvedFile);
    const slice = buf.subarray(0, Math.min(buf.length, maxBytes));
    let text = slice.toString("utf8");
    if (buf.length > maxBytes) {
      text += "\n…[truncated]";
    }
    const t = text.trim();
    return t.length > 0 ? t : undefined;
  } catch {
    return undefined;
  }
}

function tryResolveWorkspaceRoot(raw: string | undefined): string | undefined {
  const t = raw?.trim();
  if (!t) return undefined;
  try {
    return realpathSync(resolve(t));
  } catch {
    return undefined;
  }
}

function resolveOperatorInstructionsCandidatePath(operatorRootReal: string, chosen: string): string {
  const t = chosen.trim();
  if (!t) return join(operatorRootReal, OPERATOR_GLOBAL_INSTRUCTIONS_BASENAME);
  return isAbsolute(t) ? resolve(t) : resolve(operatorRootReal, t);
}

/**
 * Reads operator global instructions from disk. Path must resolve under the real operator directory
 * (blocks symlink escapes). `SHOGGOTH_GLOBAL_INSTRUCTIONS_PATH` overrides config and default basename.
 */
function safeReadOperatorGlobalInstructions(
  input: BuildSessionSystemContextInput,
  env: NodeJS.ProcessEnv,
  maxBytes: number,
): string | undefined {
  if (maxBytes <= 0) return undefined;

  const opRootRaw = (input.config?.operatorDirectory?.trim() || LAYOUT.operatorDir).trim();
  let operatorRootReal: string;
  try {
    operatorRootReal = realpathSync(resolve(opRootRaw));
  } catch {
    return undefined;
  }

  const envOverride = env.SHOGGOTH_GLOBAL_INSTRUCTIONS_PATH?.trim();
  const cfgPath = input.config?.globalInstructionsPath?.trim();
  const defaultRel = join(operatorRootReal, OPERATOR_GLOBAL_INSTRUCTIONS_BASENAME);
  const chosen = envOverride ?? cfgPath ?? defaultRel;
  const candidate = resolveOperatorInstructionsCandidatePath(operatorRootReal, chosen);

  if (!existsSync(candidate)) return undefined;

  let resolvedFile: string;
  try {
    resolvedFile = realpathSync(candidate);
  } catch {
    return undefined;
  }

  if (!isPathInsideResolvedRoot(operatorRootReal, resolvedFile)) return undefined;

  try {
    const buf = readFileSync(resolvedFile);
    const slice = buf.subarray(0, Math.min(buf.length, maxBytes));
    let text = slice.toString("utf8");
    if (buf.length > maxBytes) {
      text += "\n…[truncated]";
    }
    const t = text.trim();
    return t.length > 0 ? t : undefined;
  } catch {
    return undefined;
  }
}

function formatPrimaryModelLabel(
  models: ShoggothConfig["models"] | undefined,
  env: NodeJS.ProcessEnv,
): string {
  const chain = models?.failoverChain;
  if (chain?.length) {
    const first = chain[0]!;
    return `${first.model} (provider: ${first.providerId})`;
  }
  if (env.ANTHROPIC_BASE_URL?.trim()) {
    const model = env.SHOGGOTH_MODEL?.trim() || "claude-3-5-sonnet-20241022";
    return `${model} (anthropic-messages / env)`;
  }
  const model = env.SHOGGOTH_MODEL?.trim() || "gpt-4o-mini";
  return `${model} (openai-compatible / env)`;
}

function buildIdentitySection(channel: string | undefined): string {
  const channelSurface = channel ? ` over **${channel}**` : "";
  return daemonPrompt("system-identity", { channelSurface });
}

function buildShoggothCliAndDocsSection(): string {
  return daemonPrompt("system-cli-docs", { referenceDocsDir: SHOGGOTH_REFERENCE_DOCS_DIR });
}

function buildToolingSection(toolNames: readonly string[] | undefined): string {
  const names = toolNames?.length ? [...toolNames].sort() : [];
  const toolListBlock =
    names.length === 0
      ? "*(No tool list was attached for this turn.)*"
      : ["Tools available this turn:", ...names.map((n) => `- \`${n}\``)].join("\n");
  return daemonPrompt("system-tooling", { toolListBlock });
}

function buildSafetySection(): string {
  return daemonPrompt("system-safety");
}

function buildWorkspaceSection(
  resolvedRoot: string | undefined,
  sandbox: BuildSessionSystemContextInput["sandbox"],
): string {
  const uid = sandbox?.runtimeUid;
  const gid = sandbox?.runtimeGid;
  const sandboxLine =
    uid !== undefined || gid !== undefined
      ? `Sandbox identity: uid=${uid ?? "?"} gid=${gid ?? "?"}.`
      : "";
  if (resolvedRoot) {
    return daemonPrompt("system-workspace-root", { resolvedRoot, sandboxLine });
  }
  return daemonPrompt("system-workspace-none", { sandboxLine });
}

function buildMemoryConfigHint(
  config: ShoggothConfig | undefined,
  sessionId: string | undefined,
): string | undefined {
  const paths =
    config && sessionId
      ? resolveEffectiveMemoryForSession(config, sessionId).paths
      : config?.memory?.paths;
  if (!paths?.length) return undefined;
  const memoryPathLines = paths.map((p) => `- \`${p}\``).join("\n");
  return `\n${daemonPrompt("system-memory-hint", { memoryPathLines })}`;
}

function buildProjectContextSection(
  operatorGlobal: string | undefined,
  fileBlocks: string[],
  soulPresent: boolean,
): string | undefined {
  if (!operatorGlobal && fileBlocks.length === 0) return undefined;
  let s = daemonPrompt("system-project-context-title");

  if (operatorGlobal) {
    s += `\n\n${daemonPrompt("system-project-operator-block", { operatorGlobal })}`;
  }

  if (fileBlocks.length > 0) {
    s += `\n\n${daemonPrompt("system-project-workspace-intro")}`;
    if (soulPresent) {
      s += `\n\n${daemonPrompt("system-soul-guidance")}`;
    }
    s += `\n\n${daemonPrompt("system-workspace-files-heading")}\n\n${fileBlocks.join("\n")}\n--- end workspace files ---`;
  }

  return s;
}

function buildHeartbeatsSection(): string {
  return daemonPrompt("system-heartbeats");
}

function buildSilentRepliesSection(input: {
  readonly messagingCapabilities: MessagingAdapterCapabilities | undefined;
  readonly channel: string | undefined;
}): string {
  if (messagingCapabilitiesHasFeature(input.messagingCapabilities, MESSAGING_FEATURE.SILENT_REPLIES_CHANNEL_AWARE)) {
    return daemonPrompt("system-silent-replies-discord");
  }
  return daemonPrompt("system-silent-replies-default");
}

function buildRuntimeSection(input: {
  readonly sessionId: string | undefined;
  readonly contextSegmentId: string | undefined;
  readonly channel: string | undefined;
  readonly resolvedWorkspace: string | undefined;
  readonly modelLabel: string;
  readonly toolCount: number;
}): string {
  const caps = [
    "tools",
    input.toolCount > 0 ? `tool_count=${input.toolCount}` : "tool_count=0",
    "policy",
    "hitl",
  ].join("; ");
  const parts = [
    `session=${input.sessionId ?? "unknown"}`,
    input.contextSegmentId ? `context_segment=${input.contextSegmentId}` : undefined,
    input.channel ? `channel=${input.channel}` : undefined,
    input.resolvedWorkspace ? `workspace=${input.resolvedWorkspace}` : "workspace=(none)",
    `host=${hostname()}`,
    `os=${process.platform}`,
    `node=${process.version}`,
    `model=${input.modelLabel}`,
    `capabilities=${caps}`,
  ].filter(Boolean);
  return daemonPrompt("system-runtime", { runtimeSummary: parts.join(" · ") });
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

/** Approximate token count: ~4 chars per token (cl100k_base heuristic). */
function estimateTokens(text: string | null): number {
  return text ? Math.max(1, Math.ceil(text.length / 4)) : 0;
}

function buildSessionStatsSection(
  stateDb: Database.Database | undefined,
  sessionId: string | undefined,
  transcriptMessages?: readonly { role: string; content: string | null }[],
  assembledPromptLength?: number,
): string | undefined {
  if (!stateDb || !sessionId) return undefined;
  const stats = getSessionStats(stateDb, sessionId);
  if (!stats) return undefined;

  // Base: cumulative actual token usage from the DB (current segment).
  let tokenCount = stats.inputTokens + stats.outputTokens;
  let tokenDisplay: string;

  if (transcriptMessages && transcriptMessages.length > 0) {
    // Add estimated tokens for the system prompt and current user message
    // (not yet recorded in the DB since this turn hasn't completed).
    const systemPromptTokens = assembledPromptLength
      ? Math.ceil(assembledPromptLength / 4)
      : 0;
    const lastUserMsg = [...transcriptMessages].reverse().find(m => m.role === "user");
    const currentMsgTokens = lastUserMsg ? estimateTokens(lastUserMsg.content) : 0;
    tokenCount += systemPromptTokens + currentMsgTokens;
    tokenDisplay = `~${formatNumber(tokenCount)}`;
  } else {
    tokenDisplay = formatNumber(tokenCount);
  }

  let contextWindowSuffix = "";
  if (stats.contextWindowTokens != null) {
    const pct = ((tokenCount / stats.contextWindowTokens) * 100).toFixed(1);
    contextWindowSuffix = ` / ${formatNumber(stats.contextWindowTokens)} (${pct}%)`;
  }

  return [
    "## Session Stats\n",
    `Tokens used: ${tokenDisplay}${contextWindowSuffix} · Turns: ${stats.turnCount} · Compactions: ${stats.compactionCount} · Messages: ${stats.transcriptMessageCount}`,
  ].join("\n");
}

function appendEnvSystemPrompt(base: string, env: NodeJS.ProcessEnv | undefined): string {
  const extra = env?.SHOGGOTH_SESSION_SYSTEM_PROMPT?.trim();
  if (!extra) return base;
  return `${base}\n\n${daemonPrompt("system-env-session-appendix", { extra })}`;
}

function joinSections(sections: (string | undefined)[]): string {
  return sections.filter((s): s is string => Boolean(s?.trim())).join("\n\n");
}

/**
 * Assembles the model system string: identity, tooling, safety, workspace, optional project
 * context (operator global instructions before workspace templates), heartbeats / silent-reply
 * notes, runtime metadata, and optional `SHOGGOTH_SESSION_SYSTEM_PROMPT`.
 */
export function buildSessionSystemContext(input: BuildSessionSystemContextInput): string {
  const env = input.env ?? process.env;
  const root = input.workspacePath?.trim();
  const resolvedRoot = tryResolveWorkspaceRoot(root);

  let totalPayloadBytes = 0;
  const remainingForGlobal = DEFAULT_MAX_TOTAL_TEMPLATE_BYTES - totalPayloadBytes;
  const globalCap = Math.min(DEFAULT_MAX_BYTES_PER_FILE, remainingForGlobal);
  const operatorGlobal = safeReadOperatorGlobalInstructions(input, env, globalCap);
  if (operatorGlobal) {
    totalPayloadBytes += Buffer.byteLength(operatorGlobal, "utf8");
  }

  const fileBlocks: string[] = [];
  let soulPresent = false;

  if (root) {
    for (const name of WORKSPACE_TEMPLATE_FILES) {
      if (totalPayloadBytes >= DEFAULT_MAX_TOTAL_TEMPLATE_BYTES) break;
      const remaining = DEFAULT_MAX_TOTAL_TEMPLATE_BYTES - totalPayloadBytes;
      const perFileCap = Math.min(DEFAULT_MAX_BYTES_PER_FILE, remaining);
      const body = safeReadWorkspaceTemplate(root, name, perFileCap);
      if (!body) continue;
      if (name === "SOUL.md") soulPresent = true;

      const payloadBytes = Buffer.byteLength(body, "utf8");
      totalPayloadBytes += payloadBytes;
      fileBlocks.push(`--- workspace: ${name} ---\n\n${body}\n`);
    }
  }

  const toolNames = input.toolNames;
  const toolCount = toolNames?.length ?? 0;

  const workspaceBody =
    buildWorkspaceSection(resolvedRoot, input.sandbox) +
    (buildMemoryConfigHint(input.config, input.sessionId) ?? "");

  // Build core sections without stats first so we can estimate prompt length for token calculation.
  const coreSansStats = joinSections([
    buildIdentitySection(input.channel),
    buildShoggothCliAndDocsSection(),
    buildToolingSection(toolNames),
    buildSafetySection(),
    workspaceBody,
    buildProjectContextSection(operatorGlobal, fileBlocks, soulPresent),
    buildHeartbeatsSection(),
    buildSilentRepliesSection({
      messagingCapabilities: input.messagingCapabilities,
      channel: input.channel,
    }),
    buildRuntimeSection({
      sessionId: input.sessionId,
      contextSegmentId: input.contextSegmentId,
      channel: input.channel,
      resolvedWorkspace: resolvedRoot,
      modelLabel: formatPrimaryModelLabel(
        input.sessionId && input.config
          ? resolveEffectiveModelsConfig(input.config, input.sessionId) ?? input.config.models
          : input.config?.models,
        env,
      ),
      toolCount,
    }),
  ]);

  const statsSection = buildSessionStatsSection(
    input.stateDb,
    input.sessionId,
    input.transcriptMessages,
    coreSansStats.length,
  );

  const core = statsSection ? `${coreSansStats}\n\n${statsSection}` : coreSansStats;

  return appendEnvSystemPrompt(core, env);
}
