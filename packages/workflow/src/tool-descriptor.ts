/** Shape-compatible with McpToolDescriptor without requiring the dependency. */
export interface WorkflowToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

const workflowToolArgs = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["start", "abort", "pause", "resume", "status", "list", "post", "edit", "retry", "retention", "wait"],
      description:
        "start: kick off a new workflow. abort/pause/resume: control a running workflow. status: get task states. list: list workflows. post: repost status message. edit: modify a non-in-progress task. retry: redrive a failed task. retention: prune old workflows. wait: block until workflow completes.",
    },
    // --- start ---
    name: {
      type: "string",
      description: "start: human-readable workflow name.",
    },
    tasks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer", description: "Unique task number (1-based)." },
          prompt: { type: "string", description: "Task prompt. May contain {{task:N:output}} or {{task:N:success}} templates." },
          title: { type: "string", description: "Optional display title for status/summary posts (max 60 chars). Falls back to truncated prompt.", maxLength: 60 },
          failure_behavior: {
            type: "string",
            enum: ["abort", "pause", "continue"],
            description: "What to do if this task fails. Default: continue.",
          },
          failure_notification: {
            description: "Who to notify on failure. Default: silent.",
            oneOf: [
              { type: "string", const: "silent" },
              { type: "object", properties: { kind: { const: "notify-parent" } }, required: ["kind"] },
              {
                type: "object",
                properties: {
                  kind: { const: "notify-target" },
                  target_id: { type: "string" },
                },
                required: ["kind", "target_id"],
              },
            ],
          },
          runtime_limit_ms: {
            type: "integer",
            description: "Max runtime for this task in ms. Default: 600000 (10 min).",
            minimum: 1000,
          },
        },
        required: ["id", "prompt"],
      },
      description: "start: array of task definitions.",
    },
    graph: {
      type: "string",
      description:
        "start: dependency graph DSL. Syntax: 1>2 (dependency), 1-3 (chain), 1,3>4 (group dep), space-separated lanes.",
    },
    polling_interval_ms: {
      type: "integer",
      description: "start: polling interval in ms. Default: 10000.",
      minimum: 1000,
    },
    runtime_limit_ms: {
      type: "integer",
      description: "start: default runtime limit per task in ms. Default: 600000.",
      minimum: 1000,
    },
    reply_to: {
      type: "string",
      description: "start: session ID where subagent results should be delivered.",
    },
    concurrency: {
      type: "integer",
      description: "start: max tasks running in parallel. Default: unlimited.",
      minimum: 1,
    },
    // --- workflow targeting ---
    workflow_id: {
      type: "string",
      description: "abort/pause/resume/status/post/edit/retry: target workflow ID.",
    },
    // --- edit ---
    task_id: {
      type: "integer",
      description: "edit/retry: target task number.",
    },
    prompt: {
      type: "string",
      description: "edit: new prompt for the task.",
    },
    failure_behavior: {
      type: "string",
      enum: ["abort", "pause", "continue"],
      description: "edit: new failure behavior.",
    },
    failure_notification: {
      description: "edit: new failure notification config.",
      oneOf: [
        { type: "string", const: "silent" },
        { type: "object", properties: { kind: { const: "notify-parent" } }, required: ["kind"] },
        {
          type: "object",
          properties: {
            kind: { const: "notify-target" },
            target_id: { type: "string" },
          },
          required: ["kind", "target_id"],
        },
      ],
    },
    // --- retry ---
    cascade: {
      type: "boolean",
      description: "retry: also re-run completed downstream tasks. Default: false.",
    },
    // --- list ---
    agent_chain_id: {
      type: "string",
      description: "list: filter by agent chain ID. Defaults to calling agent's chain.",
    },
    // --- wait ---
    timeout_ms: {
      type: "integer",
      description: "wait: max time to wait in ms. Default: 600000 (10 min).",
      minimum: 1000,
    },
  },
  required: ["action"],
} as const;

export function buildWorkflowToolDescriptor(): WorkflowToolDescriptor {
  return {
    name: "workflow",
    description:
      "Orchestrate parallel and sequential subagent workflows. Break work into tasks with a dependency graph, track progress with live status messages, and control execution with pause/resume/retry/abort.",
    inputSchema: workflowToolArgs,
  };
}
