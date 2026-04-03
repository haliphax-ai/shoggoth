import type { ProcessManager } from "@shoggoth/procman";
import type { TaskDef } from "./types.js";
import {
  Orchestrator,
  type SpawnAdapter,
  type PollAdapter,
  type NotifyAdapter,
  type NotificationAdapter,
  type OrchestratorOptions,
} from "./orchestrator.js";
import type { StatusManager } from "./status-manager.js";
import { listIncompleteWorkflows } from "./state.js";

const PROCESS_ID = "workflow-orchestrator";

export interface WorkflowServerOptions {
  stateDir: string;
  spawner: SpawnAdapter;
  poller: PollAdapter;
  notifier: NotifyAdapter;
  /** Factory to create a per-workflow StatusManager bound to the calling session. */
  createStatusManager?: (sessionId: string) => StatusManager;
  /** Factory to create a per-workflow NotificationAdapter for task failure delivery. */
  createNotificationAdapter?: (sessionId: string) => NotificationAdapter;
}

/**
 * Workflow server — registers the orchestrator as a managed concept
 * within the procman ecosystem and provides the high-level `start` entry point.
 *
 * Note: The orchestrator itself is not a child process; it runs in-process
 * using timers. The server acts as the lifecycle wrapper that procman
 * can track, and handles workflow resume on startup.
 */
export class WorkflowServer {
  private readonly opts: WorkflowServerOptions;
  private readonly orchestrators = new Map<string, Orchestrator>();

  constructor(opts: WorkflowServerOptions) {
    this.opts = opts;
  }

  /** Resume any incomplete workflows found on disk. */
  async resume(): Promise<string[]> {
    const incomplete = listIncompleteWorkflows(this.opts.stateDir);
    const resumed: string[] = [];

    for (const wf of incomplete) {
      const orch = new Orchestrator(this.opts.spawner, this.opts.poller, this.opts.notifier);
      // Restore workflow state into the orchestrator and start polling
      orch.restore(wf, {
        stateDir: this.opts.stateDir,
        currentDepth: 0,
        maxDepth: 2,
        replyTo: "",
        pollingIntervalMs: wf.pollingIntervalMs,
        runtimeLimitMs: wf.runtimeLimitMs ?? 600_000,
      });
      orch.startPolling();
      this.orchestrators.set(wf.id, orch);
      resumed.push(wf.id);
    }

    return resumed;
  }

  /** Start a new workflow. Returns the workflow ID. */
  async start(
    tasks: TaskDef[],
    graphDsl: string,
    opts: OrchestratorOptions,
  ): Promise<string> {
    const orch = new Orchestrator(this.opts.spawner, this.opts.poller, this.opts.notifier, this.opts.createStatusManager?.(opts.replyTo), this.opts.createNotificationAdapter?.(opts.replyTo));
    const wfId = await orch.start(tasks, graphDsl, opts);
    orch.startPolling();
    this.orchestrators.set(wfId, orch);
    return wfId;
  }

  /** Get an orchestrator by workflow ID. */
  get(workflowId: string): Orchestrator | undefined {
    return this.orchestrators.get(workflowId);
  }

  /** Expose the orchestrators map for control plane integration. */
  getOrchestrators(): Map<string, Orchestrator> {
    return this.orchestrators;
  }

  /** Stop all active orchestrators. */
  async stopAll(): Promise<void> {
    for (const orch of this.orchestrators.values()) {
      orch.stopPolling();
    }
    this.orchestrators.clear();
  }

  static get processId(): string {
    return PROCESS_ID;
  }
}
