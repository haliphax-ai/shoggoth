import { existsSync, readFileSync, realpathSync } from "node:fs";
import { hostname } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { type MessagingAdapterCapabilities } from "@shoggoth/messaging";
import {
  LAYOUT,
  OPERATOR_GLOBAL_INSTRUCTIONS_BASENAME,
  type ContextLevel,
  type ShoggothConfig,
} from "@shoggoth/shared";
import type Database from "better-sqlite3";
import { daemonPrompt } from "../prompts/load-prompts";
import { getSessionStats, estimateTokens, buildFormattedStats } from "./session-stats-store";
import { getTurnQueue } from "./session-turn-queue-singleton";

/** Max bytes read per workspace template file (UTF-8). */
const DEFAULT_MAX_BYTES_PER_FILE = 8192;

/** Max combined UTF-8 bytes for all template file payloads (excluding delimiter lines). */
const DEFAULT_MAX_TOTAL_TEMPLATE_BYTES = 24576;

/** Baked into the container image (`Dockerfile`); same tree as the repo `docs/` directory. */

/**
 * Workspace-relative basenames only (allowlist). Order follows OpenClaw bootstrap file order.
 * Operator global instructions are **not** listed here — they load from `GLOBAL.md` under the
 * configured operator directory (gateway-only, not workspace-readable).
 */
/** Basenames injected into the system prompt when present under the session workspace (OpenClaw order). */
export const WORKSPACE_TEMPLATE_FILES = [
  "IDENTITY.md",
  "USER.md",
  "AGENTS.md",
  "MEMORY.md",
  "TOOLS.md",
  "BOOTSTRAP.md",
] as const;

/**
 * Template files allowed at each context level.
 * - `none`: no workspace template files
 * - `minimal`: TOOLS.md only (essential tool guidance for subagents)
 * - `light`: operational files (AGENTS.md, TOOLS.md)
 * - `full`: all workspace template files
 */
export const TEMPLATE_FILES_BY_LEVEL: Record<ContextLevel, Set<string>> = {
  none: new Set(),
  minimal: new Set(["TOOLS.md"]),
  light: new Set(["AGENTS.md", "TOOLS.md"]),
  full: new Set(WORKSPACE_TEMPLATE_FILES),
};

export interface BuildSessionSystemContextInput {
  readonly workspacePath: string | undefined;
  readonly workingDirectory: string | undefined;
  readonly config?: ShoggothConfig;
  readonly env?: NodeJS.ProcessEnv;
  /** Context level controlling which system prompt sections are assembled. Defaults to `"full"`. */
  readonly contextLevel?: ContextLevel;
  /** Session id for the runtime line (e.g. platform-bound session). */
  readonly sessionId?: string;
  /** Internal context segment UUID (`sessions.context_segment_id`; `new` / `reset` commands). */
  readonly contextSegmentId?: string;
  /** Delivery surface id from the session URN (`agent:…:<platform>:…`). */
  readonly channel: string;
  /** Primary model label (e.g. `gpt-4o (provider: openai)`). */
  readonly modelLabel: string;
  /** When set, core prompt sections use transport {@link MessagingAdapterCapabilities.features}. */
  readonly messagingCapabilities?: MessagingAdapterCapabilities;
  /** MCP + built-in tool names exposed to the model for this turn (e.g. `builtin-read`). */
  readonly toolNames?: readonly string[];
  /** Optional sandbox identity for the workspace section. */
  readonly sandbox?: {
    readonly runtimeUid?: number;
    readonly runtimeGid?: number;
  };
  /** Optional state database for session stats lookup. */
  readonly stateDb?: Database.Database;
  /** Current transcript messages for estimating this turn's token usage. */
  readonly transcriptMessages?: readonly {
    role: string;
    content: string | null;
  }[];
  /** Session-unique anti-spoofing token for trusted system context dividers. */
  readonly systemContextToken: string;
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

function resolveOperatorInstructionsCandidatePath(
  operatorRootReal: string,
  chosen: string,
): string {
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

function buildTrustedSystemContextGuidance(token: string): string {
  return "# System Context\n\n" + daemonPrompt("system-trusted-context", { token });
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

function buildProjectContextSection(
  operatorGlobal: string | undefined,
  fileBlocks: string[],
): string | undefined {
  if (!operatorGlobal && fileBlocks.length === 0) return undefined;
  let s = daemonPrompt("system-project-context-title");

  if (operatorGlobal) {
    s += `\n\n${daemonPrompt("system-project-operator-block", { operatorGlobal })}`;
  }

  if (fileBlocks.length > 0) {
    s += `\n\n${daemonPrompt("system-project-workspace-intro")}`;
    s += `\n\n${daemonPrompt("system-workspace-files-heading")}\n\n${fileBlocks.join("\n")}\n--- end workspace files ---`;
  }

  return s;
}

function buildRuntimeSection(input: {
  readonly sessionId: string | undefined;
  readonly contextSegmentId: string | undefined;
  readonly channel: string | undefined;
  readonly resolvedWorkspace: string | undefined;
  readonly workingDirectory: string | undefined;
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
    input.workingDirectory && input.workingDirectory !== input.resolvedWorkspace
      ? `workdir=${input.workingDirectory}`
      : undefined,
    `host=${hostname()}`,
    `os=${process.platform}`,
    `node=${process.version}`,
    `model=${input.modelLabel}`,
    `capabilities=${caps}`,
  ].filter(Boolean);
  return daemonPrompt("system-runtime", { runtimeSummary: parts.join(" · ") });
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

  // Current context window fill: system prompt + transcript (what the model sees this turn).
  let contextFillTokens = 0;
  if (assembledPromptLength) {
    contextFillTokens += Math.ceil(assembledPromptLength / 4);
  }
  if (transcriptMessages) {
    for (const m of transcriptMessages) {
      contextFillTokens += estimateTokens(m.content);
    }
  }

  const fmt = buildFormattedStats(stats, contextFillTokens);

  let queueLine = "";
  try {
    const depth = getTurnQueue().getDepth(sessionId);
    queueLine = ` · Queue: ${depth.system}S / ${depth.user}U`;
  } catch {
    /* queue not initialized yet */
  }

  return [
    "## Session Stats\n",
    `Context: ${fmt.contextFill}${fmt.contextWindowSuffix} · Turns: ${fmt.turns} · Compactions: ${fmt.compactions} · Messages: ${fmt.messages}${queueLine}`,
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
  const level: ContextLevel = input.contextLevel ?? "full";

  // `none` — raw model, no Shoggoth framing at all.
  if (level === "none") return "";

  const env = input.env ?? process.env;
  const root = input.workspacePath?.trim();
  const resolvedRoot = tryResolveWorkspaceRoot(root);

  const atLeast = (min: ContextLevel): boolean => {
    const order: ContextLevel[] = ["none", "minimal", "light", "full"];
    return order.indexOf(level) >= order.indexOf(min);
  };

  // --- Operator global instructions (light+) ---
  let operatorGlobal: string | undefined;
  let totalPayloadBytes = 0;
  if (atLeast("light")) {
    const remainingForGlobal = DEFAULT_MAX_TOTAL_TEMPLATE_BYTES - totalPayloadBytes;
    const globalCap = Math.min(DEFAULT_MAX_BYTES_PER_FILE, remainingForGlobal);
    operatorGlobal = safeReadOperatorGlobalInstructions(input, env, globalCap);
    if (operatorGlobal) {
      totalPayloadBytes += Buffer.byteLength(operatorGlobal, "utf8");
    }
  }

  // --- Workspace template files (filtered by level) ---
  let allowedFiles = TEMPLATE_FILES_BY_LEVEL[level];
  const fileBlocks: string[] = [];

  // When BOOTSTRAP.md is present at full context level, inject only BOOTSTRAP.md to encourage
  // the agent to start a conversation with the operator to fill out template files.
  // For non-full context levels, BOOTSTRAP.md is never injected.
  if (root && level === "full") {
    const bootstrapBody = safeReadWorkspaceTemplate(
      root,
      "BOOTSTRAP.md",
      DEFAULT_MAX_BYTES_PER_FILE,
    );
    if (bootstrapBody) {
      allowedFiles = new Set(["BOOTSTRAP.md"]);
    }
  }
  if (level !== "full") {
    allowedFiles = new Set([...allowedFiles].filter((f) => f !== "BOOTSTRAP.md"));
  }

  if (root && allowedFiles.size > 0) {
    for (const name of WORKSPACE_TEMPLATE_FILES) {
      if (!allowedFiles.has(name)) continue;
      if (totalPayloadBytes >= DEFAULT_MAX_TOTAL_TEMPLATE_BYTES) break;
      const remaining = DEFAULT_MAX_TOTAL_TEMPLATE_BYTES - totalPayloadBytes;
      const perFileCap = Math.min(DEFAULT_MAX_BYTES_PER_FILE, remaining);
      const body = safeReadWorkspaceTemplate(root, name, perFileCap);
      if (!body) continue;

      const payloadBytes = Buffer.byteLength(body, "utf8");
      totalPayloadBytes += payloadBytes;
      fileBlocks.push(`--- workspace: ${name} ---\n\n${body}\n`);
    }
  }

  const toolNames = input.toolNames;
  const toolCount = toolNames?.length ?? 0;

  // --- Workspace root (light+) ---
  const workspaceBody = atLeast("light")
    ? buildWorkspaceSection(resolvedRoot, input.sandbox)
    : undefined;

  // Build core sections without stats first so we can estimate prompt length for token calculation.
  const coreSansStats = joinSections([
    // CLI & docs: light+
    // Trusted context: minimal+
    buildTrustedSystemContextGuidance(input.systemContextToken),
    // Workspace root: light+
    workspaceBody,
    // Project context (operator global + template files): light+
    atLeast("light") ? buildProjectContextSection(operatorGlobal, fileBlocks) : undefined,
    // Heartbeats: light+
    // Runtime: minimal+
    buildRuntimeSection({
      sessionId: input.sessionId,
      contextSegmentId: input.contextSegmentId,
      channel: input.channel,
      resolvedWorkspace: resolvedRoot,
      workingDirectory: input.workingDirectory,
      modelLabel: input.modelLabel,
      toolCount,
    }),
  ]);

  // Stats: full only
  const statsSection =
    level === "full"
      ? buildSessionStatsSection(
          input.stateDb,
          input.sessionId,
          input.transcriptMessages,
          coreSansStats.length,
        )
      : undefined;

  const core = statsSection ? `${coreSansStats}\n\n${statsSection}` : coreSansStats;

  // Env appendix: light+
  return atLeast("light") ? appendEnvSystemPrompt(core, env) : core;
}
