// ---------------------------------------------------------------------------
// Builtin Tool Registry — typed Map wrapper for dispatching builtin tool calls
// ---------------------------------------------------------------------------

import type Database from "better-sqlite3";
import { isAbsolute, resolve } from "node:path";
import type { ShoggothConfig, ShoggothMemoryConfig } from "@shoggoth/shared";
import type { AgentCredentials } from "@shoggoth/os-exec";
import type { ProcessManager } from "@shoggoth/procman";
import type { ChatContentPart, ImageBlockCodec } from "@shoggoth/models";
import type { AgentIntegrationInvoker } from "../control/integration-invoke";

/**
 * Minimal interface for the message-tool context so we don't pull in heavy
 * messaging types.  Matches `messageToolContextRef.current`.
 */
export interface MessageToolCtx {
  execute: (sessionId: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

/**
 * Everything a builtin handler may need from the calling scope.
 * Passed once per tool invocation so handlers stay pure functions.
 */
export interface BuiltinToolContext {
  readonly sessionId: string;
  readonly db: Database.Database;
  readonly config: ShoggothConfig;
  readonly env: NodeJS.ProcessEnv;
  readonly workspacePath: string;
  /** Resolved working directory for this session (defaults to workspacePath). */
  readonly workingDirectory?: string;
  readonly creds: AgentCredentials;

  /** Merged orchestrator env (config + process env). */
  readonly orchestratorEnv: NodeJS.ProcessEnv;

  /** Returns the integration invoker, or undefined if unavailable. */
  readonly getAgentIntegrationInvoker: () => AgentIntegrationInvoker | undefined;

  /** Returns the process manager singleton, or undefined if not initialised. */
  readonly getProcessManager: () => ProcessManager | undefined;

  /** The current message-tool context, if a messaging adapter is active. */
  readonly messageToolCtx: MessageToolCtx | undefined;

  /** Effective memory config resolved for this session. */
  readonly memoryConfig: ShoggothMemoryConfig;

  /** Optional runtime openaiBaseUrl from config. */
  readonly runtimeOpenaiBaseUrl: string | undefined;

  /**
   * Whether the current session is a subagent session.
   * Used by the subagent handler to reject nested spawns.
   */
  readonly isSubagentSession: boolean;

  /** Image block codec for the active model provider, or undefined when unsupported. */
  readonly imageBlockCodec?: ImageBlockCodec;
}

/** Result returned by a builtin tool handler. */
export interface BuiltinToolResult {
  readonly resultJson: string;
  /** When set, the tool result uses structured content (e.g. image blocks). */
  readonly contentParts?: ChatContentPart[];
}

export type BuiltinToolHandler = (
  args: Record<string, unknown>,
  ctx: BuiltinToolContext,
) => Promise<BuiltinToolResult>;

export class BuiltinToolRegistry {
  private readonly handlers = new Map<string, BuiltinToolHandler>();

  register(name: string, handler: BuiltinToolHandler): void {
    this.handlers.set(name, handler);
  }

  has(name: string): boolean {
    return this.handlers.has(name);
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: BuiltinToolContext,
  ): Promise<BuiltinToolResult> {
    const handler = this.handlers.get(name);
    if (!handler) {
      throw new Error(`No handler registered for builtin tool: ${name}`);
    }
    return handler(args, ctx);
  }
}

/**
 * Resolve a user-supplied path against the session's working directory.
 * Absolute paths pass through unchanged. Relative paths are resolved
 * against `ctx.workingDirectory` (falling back to `ctx.workspacePath`).
 * The result is always an absolute path suitable for passing to
 * `resolvePathForRead` / `resolvePathForWrite` with `ctx.workspacePath`
 * as the security boundary.
 */
export function resolveUserPath(ctx: BuiltinToolContext, userPath: string): string {
  if (isAbsolute(userPath)) return userPath;
  const base = ctx.workingDirectory ?? ctx.workspacePath;
  return resolve(base, userPath);
}
