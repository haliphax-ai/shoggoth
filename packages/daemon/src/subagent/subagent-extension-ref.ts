import type { SessionModelTurnDelivery } from "../messaging/session-model-turn-delivery";
import type { SessionAgentTurnResult } from "../sessions/session-agent-turn";
import type { ModelInvocationParams } from "@shoggoth/models";
import type { SystemContext } from "@shoggoth/shared";

/** Why a persistent subagent session is being torn down (for optional thread status posts). */
export type PersistentSubagentSessionEndReason = "ttl_expired" | "killed";

/**
 * Live handle to a posted OOB "processing" banner (issue #363). The platform
 * returns this from `oobTurnBanner.begin`; callers pass it straight back to
 * `finish`. `setStatusBar` streams a live bar render into the banner message
 * while the turn executes (editing-capable platforms only). `setBody` is a
 * platform-internal escape hatch used by `oobTurnBanner.finish` to edit the
 * banner message in place instead of posting a second message.
 */
export interface OobTurnBannerHandle {
  readonly sessionId: string;
  readonly setStatusBar: (line: string | null) => Promise<void>;
  readonly setBody?: (text: string) => Promise<void>;
}

/**
 * Filled from `index.ts` after a platform starts. Control-plane subagent ops consult this ref.
 */
export type SubagentRuntimeExtension = {
  readonly runSessionModelTurn: (input: {
    readonly sessionId: string;
    readonly userContent: string;
    readonly userMetadata?: Record<string, unknown>;
    readonly systemContext?: SystemContext;
    readonly delivery: SessionModelTurnDelivery;
    /** Optional override merged into the session's model invocation params (e.g. responseSchema for structured output). */
    readonly modelInvocationOverride?: Partial<ModelInvocationParams>;
    /**
     * Optional live status-bar sink for the turn. When present, the platform
     * creates a tracker wired to this sink and streams thinking/tool/prose
     * renders into it (used by the OOB banner surface so an out-of-band turn's
     * bar lands in the banner message, issue #363).
     */
    readonly statusBarSink?: { setStatusBar: (line: string | null) => Promise<void> };
  }) => Promise<SessionAgentTurnResult>;
  readonly subscribeSubagentSession: (sessionId: string) => () => void;
  /**
   * Register a platform thread ↔ session binding. Returns an idempotent
   * unregister function. Throws when the thread is already bound to a
   * different live session (stale terminated holders are reclaimed).
   */
  readonly registerPlatformThreadBinding: (
    threadChannelId: string,
    sessionId: string,
  ) => () => void;
  /**
   * Best-effort: post a short status line in the platform thread (if bound) before bindings are cleared.
   * Implementations should read session/thread ids synchronously; network I/O may continue async.
   */
  readonly announcePersistentSubagentSessionEnded?: (input: {
    readonly sessionId: string;
    readonly reason: PersistentSubagentSessionEndReason;
  }) => void;
  /**
   * Post a status/banner message to the session's bound platform surface
   * (e.g. the bound thread). Used to announce thread-bound subagent creation
   * before the first model turn fires.
   */
  readonly sendStatusMessage?: (sessionId: string, body: string) => Promise<void>;
  /** Create a standalone thread in a channel. Used when thread_id sentinel "0" is passed. */
  readonly createThread?: (
    channelId: string,
    body: { readonly name: string; readonly type?: 11 | 12 },
  ) => Promise<{ readonly id: string }>;
  /** Resolve the outbound channel ID for a session (routes + thread bindings). */
  readonly resolveOutboundChannelIdForSession?: (sessionId: string) => string | undefined;
  /** Best-effort: post a message to the operator's surface for a session (structured OOB delivery). */
  readonly postToOperator?: (input: {
    readonly sessionId: string;
    readonly userContent: string;
  }) => Promise<void>;
  /**
   * OOB turn banner surface (issue #363). `begin` posts the "processing"
   * banner and returns a handle whose `setStatusBar` streams live bar renders
   * into that message; `finish` appends the terminal banner (plus optional
   * `to_operator` content) and finalizes the bar. Resolves `undefined` from
   * `begin` when the session is not bound to a message surface or the platform
   * cannot edit messages, in which case callers fall back to plain delivery.
   */
  readonly oobTurnBanner?: {
    begin: (input: {
      readonly sessionId: string;
      readonly processing: string;
    }) => Promise<OobTurnBannerHandle | undefined>;
    finish: (input: {
      readonly handle: OobTurnBannerHandle;
      readonly terminal: string;
      readonly content?: string;
    }) => Promise<void>;
  };
  /** Pin a message in the resolved channel for a session. Optional platform capability. */
  readonly pinMessage?: (input: {
    readonly channelId: string;
    readonly messageId: string;
  }) => Promise<void>;
};

export const subagentRuntimeExtensionRef: {
  current: SubagentRuntimeExtension | undefined;
} = {
  current: undefined,
};

export function setSubagentRuntimeExtension(ext: SubagentRuntimeExtension | undefined): void {
  subagentRuntimeExtensionRef.current = ext;
}
