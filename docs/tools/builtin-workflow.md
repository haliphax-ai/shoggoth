# builtin-workflow

Orchestrate multi-task workflows with dependency graphs. Supports agent, tool, gate, transform, and message task kinds.

## Top-Level Parameters

| Param                  | Type          | Required   | Notes                                                                                               |
| ---------------------- | ------------- | ---------- | --------------------------------------------------------------------------------------------------- |
| `action`               | string        | yes        | One of: `start`, `abort`, `pause`, `resume`, `status`, `list`, `post`, `edit`, `retry`, `retention` |
| `workflow_id`          | string        | per-action | Required for: `abort`, `pause`, `resume`, `status`, `post`, `edit`, `retry`                         |
| `name`                 | string        | no         | Workflow name (default: `"unnamed-workflow"`)                                                       |
| `tasks`                | array         | start      | Array of task objects (see below)                                                                   |
| `graph`                | string        | start      | Dependency graph — task id → dependency ids                                                         |
| `reply_to`             | string        | start      | Session id to receive completion                                                                    |
| `polling_interval_ms`  | number        | no         | Poll interval (default: 10000)                                                                      |
| `runtime_limit_ms`     | number        | no         | Max workflow runtime (default: 600000)                                                              |
| `concurrency`          | number        | no         | Max concurrent tasks                                                                                |
| `task_id`              | number        | edit/retry | Target task id                                                                                      |
| `prompt`               | string        | no         | New prompt (edit action)                                                                            |
| `failure_behavior`     | string        | no         | `"abort"`, `"pause"`, or `"continue"` (edit action)                                                 |
| `failure_notification` | string/object | no         | `"silent"`, `{ "kind": "notify-parent" }`, or `{ "kind": "notify-target", "target_id": "..." }`     |
| `cascade`              | boolean       | no         | Retry downstream tasks too (retry action)                                                           |
| `agent_chain_id`       | string        | no         | Filter by agent chain (list action)                                                                 |

## Task Object

| Param                  | Type          | Required  | Notes                                                               |
| ---------------------- | ------------- | --------- | ------------------------------------------------------------------- |
| `id`                   | number        | yes       | Unique task id (referenced in graph)                                |
| `kind`                 | string        | no        | `"agent"` (default), `"tool"`, `"gate"`, `"transform"`, `"message"` |
| `title`                | string        | no        | Display title (max 60 chars)                                        |
| `prompt`               | string        | agent     | Required for agent tasks                                            |
| `tool`                 | string        | tool      | Required for tool tasks                                             |
| `args`                 | object        | tool      | Required for tool tasks                                             |
| `condition`            | string        | gate      | Required for gate tasks                                             |
| `template`             | string        | transform | Required for transform tasks                                        |
| `message`              | string        | message   | Required for message tasks                                          |
| `channel`              | string        | no        | Channel for message tasks                                           |
| `output_template`      | string        | no        | Template applied to task output                                     |
| `failure_behavior`     | string        | no        | `"abort"`, `"pause"`, or `"continue"` (default: `"continue"`)       |
| `failure_notification` | string/object | no        | Same as top-level                                                   |
| `runtime_limit_ms`     | number        | no        | Per-task timeout                                                    |

## Examples

**Start a two-task workflow (task 2 depends on task 1):**

```json
{
  "action": "start",
  "name": "build-and-test",
  "reply_to": "session-abc",
  "tasks": [
    { "id": 1, "kind": "agent", "prompt": "Run the build", "title": "Build" },
    { "id": 2, "kind": "agent", "prompt": "Run the tests", "title": "Test" }
  ],
  "graph": "1:;2:1"
}
```

**Check workflow status:**

```json
{ "action": "status", "workflow_id": "wf-123" }
```

**Status response** includes a `tasks` array. Each task object contains:

| Field           | Type    | Notes                                                                                              |
| --------------- | ------- | -------------------------------------------------------------------------------------------------- |
| `taskDef`       | object  | Task definition (id, kind, prompt, etc.)                                                          |
| `status`        | string  | One of: `pending`, `in_progress`, `done`, `failed`, `paused`, `skipped`                          |
| `startedAt`     | number? | Unix timestamp (ms) when task started — omitted for pending tasks                                 |
| `completedAt`   | number? | Unix timestamp (ms) when task completed — omitted for non-terminal tasks                         |
| `duration`      | number? | Elapsed time in ms — present on tasks that have started. Computed as `completedAt - startedAt` for completed tasks, `Date.now() - startedAt` for in-progress tasks. Omitted for pending tasks. |
| `output`        | string? | Task output (if completed successfully)                                                           |
| `error`         | string? | Error message (if failed)                                                                         |
| `sessionKey`    | string? | Session key for agent tasks                                                                       |

The response also includes workflow-level fields: `id`, `name`, `createdAt`, `pollingIntervalMs`, `concurrency`, and `graph` (serialized dependency map).

**Pause / resume / abort:**

```json
{ "action": "pause", "workflow_id": "wf-123" }
```

```json
{ "action": "resume", "workflow_id": "wf-123" }
```

```json
{ "action": "abort", "workflow_id": "wf-123" }
```

**List workflows:**

```json
{ "action": "list" }
```

**Edit a paused task's prompt:**

```json
{
  "action": "edit",
  "workflow_id": "wf-123",
  "task_id": 2,
  "prompt": "Run tests with coverage"
}
```

**Retry a failed task (with cascade):**

```json
{ "action": "retry", "workflow_id": "wf-123", "task_id": 1, "cascade": true }
```

**Post workflow results:**

```json
{ "action": "post", "workflow_id": "wf-123" }
```

**Run retention cleanup:**

```json
{ "action": "retention" }
```

## Tips

- The `graph` string encodes dependencies. Format: `taskId:dep1,dep2;taskId:dep1`. Tasks with no dependencies use an empty dep list (e.g. `1:;2:1`).
- Agent tasks spawn subagents; respect `maxDepth` (hardcoded to 2) to avoid unbounded recursion.
- Use `concurrency` to limit parallel task execution.
- `failure_behavior: "pause"` on a task lets you `edit` and `retry` without restarting the whole workflow.
