import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { AuthenticatedPrincipal } from "@shoggoth/authn";
import type { ChatMessage } from "@shoggoth/models";
import {
  createFailoverToolCallingClientFromModelsConfig,
  mergeModelInvocationParams,
  type CreateFailoverFromConfigOptions,
  type FailoverToolCallingClient,
} from "@shoggoth/models";
import { toolExec, toolRead, toolWrite, type AgentCredentials } from "@shoggoth/os-exec";
import type { ShoggothConfig } from "@shoggoth/shared";
import {
  isSubagentSessionUrn,
  resolveEffectiveMemoryForSession,
  resolveEffectiveModelsConfig,
} from "@shoggoth/shared";
import { mergeOrchestratorEnv } from "../config/effective-runtime";
import { getAgentIntegrationInvoker } from "../control/agent-integration-invoke-ref";
import { IntegrationOpError } from "../control/integration-ops";
import { runMemoryBuiltin } from "../memory/builtin-memory-tools";
import { createMcpRoutingToolExecutor } from "../mcp/tool-loop-mcp";
import { createToolLoopPolicyAndAudit } from "../policy/tool-loop-bridge";
import { runToolLoop, type RunToolLoopHitl, type RunToolLoopOptions } from "./tool-loop";
import type { TranscriptStore } from "./transcript-store";
import type { ToolRunStore } from "./tool-run-store";
import type { SessionRow } from "./session-store";
import {
  extractLatestTranscriptAssistantText,
  loadSessionTranscriptAsModelChat,
} from "./transcript-to-chat";
import {
  createSessionToolLoopModelClient,
  type SessionToolLoopFailoverState,
  type SessionToolLoopModelClient,
} from "./session-tool-loop-model-client";
import type { SessionMcpToolContext } from "./session-mcp-tool-context";
import type { PolicyEngine } from "../policy/engine";
import {
  beginSessionTurnAbortScope,
  TurnAbortedError,
} from "./session-turn-abort";
import { messageToolContextRef } from "../messaging/message-tool-context-ref";

export interface ExecuteSessionAgentTurnInput {
  readonly db: Database.Database;
  readonly sessionId: string;
  readonly session: SessionRow;
  readonly transcript: TranscriptStore;
  readonly toolRuns: ToolRunStore;
  readonly userContent: string;
  readonly userMetadata: Record<string, unknown> | undefined;
  readonly systemPrompt: string;
  readonly env: NodeJS.ProcessEnv;
  readonly config: ShoggothConfig;
  readonly policyEngine: PolicyEngine;
  readonly getHitlConfig: () => ShoggothConfig["hitl"];
  readonly hitl: Omit<RunToolLoopHitl, "config">;
  readonly loopImpl?: (opts: RunToolLoopOptions) => Promise<void>;
  readonly createToolCallingClient?: (
    models: ShoggothConfig["models"],
    options?: CreateFailoverFromConfigOptions,
  ) => FailoverToolCallingClient;
  readonly resolveMcpContext: (sessionId: string) => Promise<SessionMcpToolContext>;
  readonly stream?: {
    readonly streamModel: boolean;
    readonly onModelTextDelta?: (displayText: string) => void | Promise<void>;
  };
}

export interface SessionAgentTurnResult {
  readonly failoverMeta: SessionToolLoopFailoverState | undefined;
  readonly latestAssistantText: string;
}

function sessionCreds(uid?: number, gid?: number): AgentCredentials {
  const u = uid ?? process.getuid?.() ?? 0;
  const g = gid ?? process.getgid?.() ?? 0;
  return { uid: u, gid: g };
}

/**
 * Appends the user turn, runs the tool loop with MCP + built-ins, and returns the latest
 * assistant text plus failover metadata. Caller handles message-platform delivery and formatting.
 * CI/non-Discord entrypoint: `test/sessions/session-agent-turn.test.ts` (mocked model client).
 */
export async function executeSessionAgentTurn(
  input: ExecuteSessionAgentTurnInput,
): Promise<SessionAgentTurnResult> {
  const loopImpl = input.loopImpl ?? runToolLoop;
  const ctxSeg = input.session.contextSegmentId.trim();
  if (!ctxSeg) {
    throw new Error("executeSessionAgentTurn: session.contextSegmentId must be non-empty");
  }

  input.transcript.append({
    sessionId: input.sessionId,
    contextSegmentId: ctxSeg,
    role: "user",
    content: input.userContent,
    metadata: input.userMetadata ?? {},
  });

  const history = loadSessionTranscriptAsModelChat(input.db, input.sessionId, ctxSeg);
  const system: ChatMessage = {
    role: "system",
    content: input.systemPrompt,
  };
  const initialMessages: ChatMessage[] = [system, ...history];

  const mcpCtx = await input.resolveMcpContext(input.sessionId);

  const createToolClient =
    input.createToolCallingClient ?? createFailoverToolCallingClientFromModelsConfig;
  const modelsForSession =
    resolveEffectiveModelsConfig(input.config, input.sessionId) ?? input.config.models;
  const toolClient = createToolClient(modelsForSession, { env: input.env });

  const modelInvocation = mergeModelInvocationParams(modelsForSession, input.session.modelSelection);

  const model: SessionToolLoopModelClient = createSessionToolLoopModelClient({
    toolClient,
    initialMessages,
    tools: mcpCtx.toolsOpenAi,
    modelInvocation,
    streamModel: Boolean(input.stream?.streamModel),
    onModelTextDelta: input.stream?.onModelTextDelta,
  });

  const principal: AuthenticatedPrincipal = {
    kind: "agent",
    sessionId: input.sessionId,
    source: "agent",
  };

  const runId = randomUUID();
  const { policy, audit } = createToolLoopPolicyAndAudit({
    engine: input.policyEngine,
    principal,
    db: input.db,
    correlationId: runId,
  });

  const creds = sessionCreds(input.session.runtimeUid, input.session.runtimeGid);
  const orchestratorEnv = mergeOrchestratorEnv(input.config, input.env);

  const executor = createMcpRoutingToolExecutor({
    aggregated: mcpCtx.aggregated,
    ...(mcpCtx.external ? { external: mcpCtx.external } : {}),
    builtin: async ({ originalName, argsJson }) => {
      try {
        const args = JSON.parse(argsJson) as Record<string, unknown>;
        if (originalName === "message") {
          const ctx = messageToolContextRef.current;
          if (!ctx) {
            return { resultJson: JSON.stringify({ error: "message_tool_unavailable" }) };
          }
          const result = await ctx.execute(input.sessionId, args);
          return { resultJson: JSON.stringify(result) };
        }
        if (originalName === "subagent" || originalName.startsWith("session.")) {
          const inv = getAgentIntegrationInvoker();
          if (!inv) {
            return { resultJson: JSON.stringify({ error: "subagent_control_unavailable" }) };
          }
          if (originalName === "subagent" && isSubagentSessionUrn(input.sessionId)) {
            return { resultJson: JSON.stringify({ error: "subagent_tool_top_level_only" }) };
          }
          let op: string;
          let payload: Record<string, unknown>;
          if (originalName === "subagent") {
            const action = String(args.action ?? "").trim();
            if (!action) {
              return { resultJson: JSON.stringify({ error: "action required" }) };
            }
            if (action === "spawn_one_shot") {
              const prompt = String(args.prompt ?? "").trim();
              if (!prompt) {
                return { resultJson: JSON.stringify({ error: "prompt required" }) };
              }
              op = "subagent_spawn";
              payload = {
                parent_session_id: input.sessionId,
                prompt,
                mode: "one_shot",
              };
            } else if (action === "spawn_bound") {
              const prompt = String(args.prompt ?? "").trim();
              const threadId = String(args.thread_id ?? "").trim();
              if (!prompt || !threadId) {
                return { resultJson: JSON.stringify({ error: "thread_id and prompt required" }) };
              }
              op = "subagent_spawn";
              payload = {
                parent_session_id: input.sessionId,
                prompt,
                mode: "bound_discord_thread",
                discord_thread_id: threadId,
              };
              const du = args.discord_user_id;
              if (typeof du === "string" && du.trim()) payload.discord_user_id = du.trim();
              const rt = args.reply_to_message_id;
              if (typeof rt === "string" && rt.trim()) payload.reply_to_message_id = rt.trim();
              const lt = args.lifetime_ms;
              if (typeof lt === "number" && Number.isFinite(lt) && lt > 0) {
                payload.lifetime_ms = Math.trunc(lt);
              }
            } else if (action === "inspect") {
              op = "session_inspect";
              payload = { session_id: input.sessionId };
            } else if (action === "steer") {
              const sid = String(args.session_id ?? "").trim();
              const prompt = String(args.prompt ?? "").trim();
              if (!sid || !prompt) {
                return { resultJson: JSON.stringify({ error: "session_id and prompt required" }) };
              }
              op = "session_steer";
              payload = { session_id: sid, prompt };
              const del = args.delivery;
              if (del === "internal") payload.delivery = "internal";
              const du = args.discord_user_id;
              if (typeof du === "string" && du.trim()) payload.discord_user_id = du.trim();
              const rt = args.reply_to_message_id;
              if (typeof rt === "string" && rt.trim()) payload.reply_to_message_id = rt.trim();
            } else if (action === "abort") {
              const sid = String(args.session_id ?? "").trim();
              if (!sid) {
                return { resultJson: JSON.stringify({ error: "session_id required" }) };
              }
              op = "session_abort";
              payload = { session_id: sid };
            } else if (action === "kill") {
              const sid = String(args.session_id ?? "").trim();
              if (!sid) {
                return { resultJson: JSON.stringify({ error: "session_id required" }) };
              }
              op = "session_kill";
              payload = { session_id: sid };
            } else {
              return {
                resultJson: JSON.stringify({ error: `unknown subagent action: ${action}` }),
              };
            }
          } else if (originalName === "session.list") {
            op = "session_list";
            payload = {};
            const st = args.status;
            if (typeof st === "string" && st.trim()) payload.status = st.trim();
            const aid = args.agent_id;
            if (typeof aid === "string" && aid.trim()) payload.agent = aid.trim();
          } else if (originalName === "session.send") {
            const message = String(args.message ?? "").trim();
            if (!message) {
              return { resultJson: JSON.stringify({ error: "message required" }) };
            }
            op = "session_send";
            payload = { message };
            if (args.silent === true) payload.silent = true;
            const sid = args.session_id;
            const agid = args.agent_id;
            const hasSid = typeof sid === "string" && sid.trim();
            const hasAg = typeof agid === "string" && agid.trim();
            if (hasSid && hasAg) {
              return {
                resultJson: JSON.stringify({ error: "set only one of session_id or agent_id" }),
              };
            }
            if (hasSid) payload.session_id = (sid as string).trim();
            else if (hasAg) payload.agent_id = (agid as string).trim();
            else {
              return {
                resultJson: JSON.stringify({ error: "session_id or agent_id required" }),
              };
            }
            const du = args.discord_user_id;
            if (typeof du === "string" && du.trim()) payload.discord_user_id = du.trim();
            const rt = args.reply_to_message_id;
            if (typeof rt === "string" && rt.trim()) payload.reply_to_message_id = rt.trim();
          } else {
            return {
              resultJson: JSON.stringify({ error: `unknown integration builtin: ${originalName}` }),
            };
          }
          const mo = args.model_options;
          const spawnAction =
            originalName === "subagent" &&
            (String(args.action ?? "").trim() === "spawn_one_shot" ||
              String(args.action ?? "").trim() === "spawn_bound");
          if (spawnAction && mo && typeof mo === "object" && !Array.isArray(mo)) {
            payload.model_options = mo;
          }
          try {
            const result = await inv(input.sessionId, op, payload);
            return { resultJson: JSON.stringify(result) };
          } catch (e) {
            if (e instanceof IntegrationOpError) {
              return {
                resultJson: JSON.stringify({
                  ok: false,
                  code: e.code,
                  message: e.message,
                }),
              };
            }
            throw e;
          }
        }
        if (originalName === "read") {
          const path = String(args.path ?? "");
          const body = await toolRead(input.session.workspacePath, path, creds);
          return { resultJson: JSON.stringify({ path, content: body }) };
        }
        if (originalName === "write") {
          const path = String(args.path ?? "");
          const content = String(args.content ?? "");
          await toolWrite(input.session.workspacePath, path, content, creds);
          return { resultJson: JSON.stringify({ ok: true, path }) };
        }
        if (originalName === "exec") {
          const argv = args.argv as unknown;
          if (!Array.isArray(argv) || argv.some((x) => typeof x !== "string")) {
            return { resultJson: JSON.stringify({ error: "exec requires string argv[]" }) };
          }
          const r = await toolExec(input.session.workspacePath, argv as string[], creds);
          return {
            resultJson: JSON.stringify({
              exitCode: r.exitCode,
              stdout: r.stdout,
              stderr: r.stderr,
            }),
          };
        }
        if (originalName === "memory.search" || originalName === "memory.ingest") {
          return runMemoryBuiltin({
            originalName,
            argsJson,
            db: input.db,
            workspacePath: input.session.workspacePath,
            memory: resolveEffectiveMemoryForSession(input.config, input.sessionId),
            env: orchestratorEnv,
            runtimeOpenaiBaseUrl: input.config.runtime?.openaiBaseUrl,
          });
        }
        return { resultJson: JSON.stringify({ error: `unknown builtin: ${originalName}` }) };
      } catch (e) {
        return { resultJson: JSON.stringify({ error: String(e) }) };
      }
    },
  });

  const { signal: turnAbortSignal, end: endTurnAbortScope } = beginSessionTurnAbortScope(
    input.sessionId,
  );
  try {
    await loopImpl({
      db: input.db,
      sessionId: input.sessionId,
      runId,
      principalId: input.sessionId,
      policy,
      audit,
      model,
      tools: mcpCtx.toolsLoop,
      executor,
      toolRuns: input.toolRuns,
      transcript: input.transcript,
      contextSegmentId: ctxSeg,
      turnAbortSignal,
      hitl: {
        ...input.hitl,
        config: input.getHitlConfig(),
      },
    });
  } catch (e) {
    if (e instanceof TurnAbortedError) {
      const failoverMeta = model.getSessionToolLoopFailoverState();
      const latestAssistantText =
        extractLatestTranscriptAssistantText(input.db, input.sessionId, ctxSeg) ?? "_Aborted._";
      return { failoverMeta, latestAssistantText };
    }
    throw e;
  } finally {
    endTurnAbortScope();
  }

  const failoverMeta = model.getSessionToolLoopFailoverState();
  const latestAssistantText =
    extractLatestTranscriptAssistantText(input.db, input.sessionId, ctxSeg) ?? "_No reply text._";

  return { failoverMeta, latestAssistantText };
}
