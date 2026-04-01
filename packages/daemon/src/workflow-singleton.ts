// ---------------------------------------------------------------------------
// Singleton WorkflowServer + ControlPlane for the daemon
// ---------------------------------------------------------------------------

import { mkdirSync } from "node:fs";
import {
  WorkflowServer,
  ControlPlane,
  StatusManager,
  handleWorkflowToolCall,
  type WorkflowToolArgs,
  type WorkflowToolResult,
  type SpawnAdapter,
  type PollAdapter,
  type NotifyAdapter,
  type NotificationAdapter,
  type KillAdapter,
  type MessageAdapter,
} from "@shoggoth/workflow";

let server: WorkflowServer | undefined;
let controlPlane: ControlPlane | undefined;
let stateDir: string | undefined;

export interface WorkflowSingletonOptions {
  /** Base directory for workflow state files. */
  stateDir: string;
  spawner: SpawnAdapter;
  poller: PollAdapter;
  notifier: NotifyAdapter;
  killer: KillAdapter;
  /** Factory to create a per-workflow MessageAdapter bound to a specific session. */
  createMessageAdapter?: (sessionId: string) => MessageAdapter;
  /** Factory to create a per-workflow NotificationAdapter for task failure delivery. */
  createNotificationAdapter?: (sessionId: string) => NotificationAdapter;
}

/** Initialize the workflow singleton. Call once at daemon startup. */
export function initWorkflow(opts: WorkflowSingletonOptions): { server: WorkflowServer; controlPlane: ControlPlane } {
  if (server && controlPlane) return { server, controlPlane };

  stateDir = opts.stateDir;
  mkdirSync(stateDir, { recursive: true });

  const createStatusManager = opts.createMessageAdapter
    ? (sessionId: string) => new StatusManager(opts.createMessageAdapter!(sessionId))
    : undefined;

  server = new WorkflowServer({
    stateDir,
    spawner: opts.spawner,
    poller: opts.poller,
    notifier: opts.notifier,
    createStatusManager,
    createNotificationAdapter: opts.createNotificationAdapter,
  });

  controlPlane = new ControlPlane({
    orchestrators: server.getOrchestrators(),
    stateDir,
    killer: opts.killer,
    spawner: opts.spawner,
  });

  return { server, controlPlane };
}

/** Get the workflow server, or undefined if not initialized. */
export function getWorkflowServer(): WorkflowServer | undefined {
  return server;
}

/** Get the workflow control plane, or undefined if not initialized. */
export function getWorkflowControlPlane(): ControlPlane | undefined {
  return controlPlane;
}

/** Execute a workflow tool call. Returns structured result. */
export async function executeWorkflowToolCall(
  args: WorkflowToolArgs,
  sessionContext: { currentDepth: number; maxDepth: number },
): Promise<WorkflowToolResult> {
  if (!server || !controlPlane || !stateDir) {
    return { ok: false, error: "workflow server not initialized" };
  }

  return handleWorkflowToolCall(args, {
    server,
    controlPlane,
    stateDir,
    currentDepth: sessionContext.currentDepth,
    maxDepth: sessionContext.maxDepth,
  });
}
