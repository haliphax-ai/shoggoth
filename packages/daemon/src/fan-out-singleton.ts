// ---------------------------------------------------------------------------
// Singleton FanOutServer + ControlPlane for the daemon
// ---------------------------------------------------------------------------

import { mkdirSync } from "node:fs";
import {
  FanOutServer,
  ControlPlane,
  StatusManager,
  handleFanOutToolCall,
  type FanOutToolArgs,
  type FanOutToolResult,
  type SpawnAdapter,
  type PollAdapter,
  type NotifyAdapter,
  type KillAdapter,
  type MessageAdapter,
} from "@shoggoth/fan-out";

let server: FanOutServer | undefined;
let controlPlane: ControlPlane | undefined;
let stateDir: string | undefined;

export interface FanOutSingletonOptions {
  /** Base directory for fan-out workflow state files. */
  stateDir: string;
  spawner: SpawnAdapter;
  poller: PollAdapter;
  notifier: NotifyAdapter;
  killer: KillAdapter;
  /** Factory to create a per-workflow MessageAdapter bound to a specific session. */
  createMessageAdapter?: (sessionId: string) => MessageAdapter;
}

/** Initialize the fan-out singleton. Call once at daemon startup. */
export function initFanOut(opts: FanOutSingletonOptions): { server: FanOutServer; controlPlane: ControlPlane } {
  if (server && controlPlane) return { server, controlPlane };

  stateDir = opts.stateDir;
  mkdirSync(stateDir, { recursive: true });

  const createStatusManager = opts.createMessageAdapter
    ? (sessionId: string) => new StatusManager(opts.createMessageAdapter!(sessionId))
    : undefined;

  server = new FanOutServer({
    stateDir,
    spawner: opts.spawner,
    poller: opts.poller,
    notifier: opts.notifier,
    createStatusManager,
  });

  controlPlane = new ControlPlane({
    orchestrators: server.getOrchestrators(),
    stateDir,
    killer: opts.killer,
  });

  return { server, controlPlane };
}

/** Get the fan-out server, or undefined if not initialized. */
export function getFanOutServer(): FanOutServer | undefined {
  return server;
}

/** Get the fan-out control plane, or undefined if not initialized. */
export function getFanOutControlPlane(): ControlPlane | undefined {
  return controlPlane;
}

/** Execute a fan_out tool call. Returns structured result. */
export async function executeFanOutToolCall(
  args: FanOutToolArgs,
  sessionContext: { currentDepth: number; maxDepth: number },
): Promise<FanOutToolResult> {
  if (!server || !controlPlane || !stateDir) {
    return { ok: false, error: "fan-out server not initialized" };
  }

  return handleFanOutToolCall(args, {
    server,
    controlPlane,
    stateDir,
    currentDepth: sessionContext.currentDepth,
    maxDepth: sessionContext.maxDepth,
  });
}
