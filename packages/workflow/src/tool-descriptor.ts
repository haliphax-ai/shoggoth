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
      enum: [
        "start",
        "abort",
        "pause",
        "resume",
        "status",
        "list",
        "post",
        "edit",
        "retry",
        "retention",
        "wait",
      ],
      description:
        "start: kick off a new workflow. abort/pause/resume: control a running workflow. status: get task states. list: list workflows. post: repost status message. edit: modify a non-in-progress task. retry: redrive a failed task. retention: prune old workflows. wait: block until a workflow completes.",
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
          kind: {
            type: "string",
            enum: ["agent", "tool", "gate", "transform", "message"],
            description: "Task kind. Default: agent.",
          },
          prompt: {
            type: "string",
            description:
              "Task prompt. May contain {{task:N:output}} or {{task:N:success}} templates.",
          },
          title: {
            type: "string",
            description:
              "Optional display title for status/summary posts (max 60 chars). Falls back to truncated prompt.",
            maxLength: 60,
          },
          failure_behavior: {
            type: "string",
            enum: ["abort", "pause", "continue"],
            description: "What to do if this task fails. Default: continue.",
          },
          failure_notification: {
            description: "Who to notify on failure. Default: silent.",
            oneOf: [
              { type: "string", const: "silent" },
              {
                type: "object",
                properties: { kind: { const: "notify-parent" } },
                required: ["kind"],
              },
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
          tool: { type: "string", description: "Tool task: tool name." },
          args: { type: "object", description: "Tool task: tool arguments." },
          condition: {
            type: "string",
            description: "Gate task: condition expression.",
          },
          template: {
            type: "string",
            description: "Transform task: template string.",
          },
          message: {
            type: "string",
            description:
              "Message task: message body. Supports {{task:N:output}} / {{task:N:success}} refs.",
          },
          channel: {
            type: "string",
            description: "Message task: target channel. Defaults to replyTo session.",
          },
          output_template: {
            type: "string",
            description:
              "Optional: reshape task output before downstream consumption. Supports {{self.output}}, {{self.error}}.",
          },
          response_schema: {
            type: "object",
            description: "Optional: constrain the task's final response to this JSON schema.",
            properties: {
              schema: { type: "object", description: "JSON Schema object." },
            },
            required: ["schema"],
          },
          model_options: {
            type: "object",
            description:
              "Optional: per-task model override for agent tasks. Highest priority in the model selection chain.",
            properties: {
              model: { type: "string", description: "Model identifier to use for this task." },
            },
          },
          enable_tools: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional: tool IDs or glob patterns (e.g. 'kanban-*') to enable for the agent task's subagent session. Added to the configured defaults.",
          },
          contract: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: {
                  type: "string",
                  description:
                    "File or folder path (relative to the task's working directory, or absolute inside its git repository)",
                },
                action: {
                  type: "string",
                  enum: ["create", "update", "delete"],
                  description: "The required modification type on this path",
                },
                summary: {
                  type: "string",
                  description: "Brief summary of the expected change (not exact lines or contents)",
                },
              },
              required: ["path", "action", "summary"],
            },
            description:
              "Optional: contract mode for agent tasks. When a non-empty array is given, the task succeeds only if every target was inside a git repository at spawn time, was acted upon with its contractual action, and the resulting git diff is judged fulfilled by a decision model in batches (any yes-probability below agents.contract.yesMinimum, default 0.85, counts as not fulfilled).",
          },
          judge: {
            type: "string",
            description:
              "Optional: decision model id (provider-id/model-name) used to judge the task's contract; must be a configured decision provider/model. Unset uses agents.contract.model or the decision config default.",
          },
        },
        required: ["id"],
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
    definition_file: {
      type: "string",
      description:
        "start: path to a JSON file containing the workflow definition ({tasks: [...], graph: '...'}). Relative paths are resolved against the agent's workspace. Absolute paths are validated against the agent's workspace. When provided, takes precedence over inline tasks/graph. Lets callers build up large workflow definitions across multiple tool calls.",
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
        {
          type: "object",
          properties: { kind: { const: "notify-parent" } },
          required: ["kind"],
        },
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
    wait_timeout_ms: {
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
      "Orchestrate parallel and sequential subagent workflows. Break work into tasks with a dependency graph, track progress with live status messages, and control execution with pause/resume/retry/abort. You will be notified on workflow completion or failure — do not block your turn waiting for results. Use 'status' for a point-in-time snapshot if needed.",
    inputSchema: workflowToolArgs,
  };
}
