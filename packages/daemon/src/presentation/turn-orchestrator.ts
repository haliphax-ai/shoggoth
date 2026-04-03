import type { ShoggothConfig } from "@shoggoth/shared";
import type { SessionToolLoopFailoverState } from "../sessions/session-tool-loop-model-client.js";
import type { PlatformAdapter, StreamHandle } from "./platform-adapter.js";
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
  /**
   * When provided, the orchestrator uses this already-started stream handle
   * instead of calling `adapter.startStream`. Useful when the platform needs
   * to start the stream before a typing indicator (e.g. Discord).
   */
  readonly preStartedStreamHandle?: StreamHandle;
  /** Called when stream start fails (only relevant when no preStartedStreamHandle). */
  readonly onStreamStartFailed?: (message: string) => void;
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
  /** Optional config ref for live-reloaded config (takes precedence over `config`). */
  readonly configRef?: { readonly current: ShoggothConfig };
  /** Prefix prepended to error replies (e.g. "⚠️ "). Default: "". */
  readonly errorReplyPrefix?: string;
}

export class PresentationTurnOrchestrator {
  private readonly deps: PresentationTurnOrchestratorDeps;

  constructor(deps: PresentationTurnOrchestratorDeps) {
    this.deps = deps;
  }

  private get config(): ShoggothConfig {
    return this.deps.configRef?.current ?? this.deps.config;
  }

  private get env(): NodeJS.ProcessEnv | undefined {
    return this.deps.env;
  }

  private get adapter(): PlatformAdapter {
    return this.deps.adapter;
  }

  private get streamingIntervalMs(): number {
    return this.deps.streamingIntervalMs ?? 0;
  }

  async orchestrateInboundTurn(input: OrchestrateTurnInput): Promise<void> {
    const { sessionId, replyToMessageId, buildTurn, mcpLifecycle, logContext, onTurnExecutionFailed } = input;
    const { adapter, config, env } = this;
    const maxLen = adapter.maxBodyLength;
    const errorPrefix = this.deps.errorReplyPrefix ?? "";

    const sliceDisplayText = (text: string): string =>
      text.length > maxLen ? text.slice(0, maxLen) : text;

    // If a pre-started stream handle was provided, wrap it; otherwise let
    // runInboundSessionTurn call adapter.startStream lazily.
    let streaming: RunInboundSessionTurnOptions["streaming"];
    if (input.preStartedStreamHandle) {
      streaming = {
        minIntervalMs: this.streamingIntervalMs,
        start: () => Promise.resolve(input.preStartedStreamHandle!),
      };
    } else if (adapter.startStream && this.streamingIntervalMs > 0) {
      streaming = {
        minIntervalMs: this.streamingIntervalMs,
        start: () => adapter.startStream!(sessionId, { replyTo: replyToMessageId }),
        onStartFailed: input.onStreamStartFailed,
      };
    }

    await runInboundSessionTurn({
      buildTurn,
      streaming,
      sliceDisplayText,
      formatAssistantReply: (latestText: string, failoverMeta: SessionToolLoopFailoverState | undefined) =>
        formatAssistantReply(config, sessionId, env, latestText, failoverMeta),
      formatErrorReply: (err: unknown) => `${errorPrefix}${formatErrorUserText(err)}`,
      sendAssistantBody: (body: string) => adapter.sendBody(sessionId, body, { replyTo: replyToMessageId }),
      sendErrorBody: (body: string) => adapter.sendError(sessionId, body, { replyTo: replyToMessageId }),
      mcpLifecycle,
      logContext,
      onTurnExecutionFailed,
    });
  }
}
