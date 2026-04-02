import type { ShoggothConfig } from "@shoggoth/shared";
import type { SessionToolLoopFailoverState } from "../sessions/session-tool-loop-model-client.js";
import type { PlatformAdapter } from "./platform-adapter.js";
import type { InboundSessionTurnInput } from "../messaging/inbound-session-turn.js";
import {
  runInboundSessionTurn,
  type RunInboundSessionTurnOptions,
} from "../messaging/inbound-session-turn.js";
import {
  formatAssistantReply,
  formatErrorUserText,
} from "./reply-formatter.js";

// ---------------------------------------------------------------------------
// Per-turn input provided by the caller
// ---------------------------------------------------------------------------

export interface OrchestrateTurnInput {
  readonly sessionId: string;
  readonly replyToMessageId?: string;
  readonly buildTurn: () => Promise<InboundSessionTurnInput>;
  readonly mcpLifecycle?: RunInboundSessionTurnOptions["mcpLifecycle"];
  readonly logContext?: Record<string, string | undefined>;
  readonly onTurnExecutionFailed?: (err: unknown) => void;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface PresentationTurnOrchestratorDeps {
  readonly config: ShoggothConfig;
  readonly env?: NodeJS.ProcessEnv;
  readonly adapter: PlatformAdapter;
  /** Streaming coalesce interval in ms; 0 disables streaming. */
  readonly streamingIntervalMs?: number;
}

export class PresentationTurnOrchestrator {
  private readonly config: ShoggothConfig;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly adapter: PlatformAdapter;
  private readonly streamingIntervalMs: number;

  constructor(deps: PresentationTurnOrchestratorDeps) {
    this.config = deps.config;
    this.env = deps.env;
    this.adapter = deps.adapter;
    this.streamingIntervalMs = deps.streamingIntervalMs ?? 0;
  }

  async orchestrateInboundTurn(input: OrchestrateTurnInput): Promise<void> {
    const { sessionId, replyToMessageId, buildTurn, mcpLifecycle, logContext, onTurnExecutionFailed } = input;
    const { adapter, config, env } = this;
    const maxLen = adapter.maxBodyLength;

    const sliceDisplayText = (text: string): string =>
      text.length > maxLen ? text.slice(0, maxLen) : text;

    const streaming: RunInboundSessionTurnOptions["streaming"] =
      adapter.startStream && this.streamingIntervalMs > 0
        ? {
            minIntervalMs: this.streamingIntervalMs,
            start: () => adapter.startStream!(sessionId, { replyTo: replyToMessageId }),
          }
        : undefined;

    await runInboundSessionTurn({
      buildTurn,
      streaming,
      sliceDisplayText,
      formatAssistantReply: (latestText: string, failoverMeta: SessionToolLoopFailoverState | undefined) =>
        formatAssistantReply(config, sessionId, env, latestText, failoverMeta),
      formatErrorReply: (err: unknown) => formatErrorUserText(err),
      sendAssistantBody: (body: string) => adapter.sendBody(sessionId, body, { replyTo: replyToMessageId }),
      sendErrorBody: (body: string) => adapter.sendError(sessionId, body, { replyTo: replyToMessageId }),
      mcpLifecycle,
      logContext,
      onTurnExecutionFailed,
    });
  }
}
