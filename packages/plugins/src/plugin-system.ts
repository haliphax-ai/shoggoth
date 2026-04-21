// ---------------------------------------------------------------------------
// ShoggothPluginSystem — wraps hooks-plugin's PluginSystem with typed hooks

// ---------------------------------------------------------------------------

import {
  PluginSystem,
  SyncHook,
  AsyncHook,
  SyncWaterfallHook,
  AsyncParallelHook,
  AsyncWaterfallHook,
} from "hooks-plugin";

import type {
  DaemonConfigureCtx,
  DaemonStartupCtx,
  DaemonReadyCtx,
  DaemonShutdownCtx,
  PlatformRegisterCtx,
  PlatformStartCtx,
  PlatformStopCtx,
  MessageInboundCtx,
  MessageOutboundCtx,
  MessageReactionCtx,
  SessionTurnBeforeCtx,
  SessionTurnAfterCtx,
  SessionSegmentChangeCtx,
  HealthRegisterCtx,
} from "./hook-types";

export function createShoggothHooks() {
  return {
    // Daemon lifecycle
    "daemon.configure": new SyncWaterfallHook<DaemonConfigureCtx>(),
    "daemon.startup": new AsyncHook<[DaemonStartupCtx]>(),
    "daemon.ready": new AsyncHook<[DaemonReadyCtx]>(),
    "daemon.shutdown": new AsyncHook<[DaemonShutdownCtx]>(),

    // Platform lifecycle
    "platform.register": new SyncHook<[PlatformRegisterCtx]>(),
    "platform.start": new AsyncHook<[PlatformStartCtx]>(),
    "platform.stop": new AsyncHook<[PlatformStopCtx]>(),

    // Messaging
    "message.inbound": new AsyncHook<[MessageInboundCtx]>(),
    "message.outbound": new AsyncWaterfallHook<MessageOutboundCtx>(),
    "message.reaction": new AsyncHook<[MessageReactionCtx]>(),

    // Session
    "session.turn.before": new AsyncHook<[SessionTurnBeforeCtx]>(),
    "session.turn.after": new AsyncHook<[SessionTurnAfterCtx]>(),
    "session.segment.change": new SyncHook<[SessionSegmentChangeCtx]>(),

    // Health
    "health.register": new SyncHook<[HealthRegisterCtx]>(),
  };
}

export type ShoggothHooks = ReturnType<typeof createShoggothHooks>;
export type ShoggothHookName = keyof ShoggothHooks;

export class ShoggothPluginSystem extends PluginSystem<ShoggothHooks> {
  constructor() {
    super(createShoggothHooks());
  }
}

/**
 * Recursively deep-freezes an object using Object.freeze.
 * Returns the same reference, now frozen at every level.
 */
export function freezeConfig<T>(obj: T): T {
  Object.freeze(obj);
  if (obj !== null && typeof obj === "object") {
    for (const value of Object.values(obj as Record<string, unknown>)) {
      if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
        freezeConfig(value);
      }
    }
  }
  return obj;
}
