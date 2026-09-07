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
| `graph`                | string        | start      | Dependency graph DSL — see Graph DSL section below                                                  |
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
  "graph": "1>2"
}
```

**Start a workflow using a definition file:**

```json
{
  "action": "start",
  "definition_file": "tmp/my-workflow.json",
  "reply_to": "session-abc"
}
```

**Start a complex workflow with group deps and chains:**

```json
{
  "action": "start",
  "name": "ci-pipeline",
  "reply_to": "session-abc",
  "tasks": [
    { "id": 1, "prompt": "Install dependencies" },
    { "id": 2, "prompt": "Run linter" },
    { "id": 3, "prompt": "Run typecheck" },
    { "id": 4, "prompt": "Run unit tests" },
    { "id": 5, "prompt": "Run integration tests" },
    { "id": 6, "prompt": "Build artifacts" },
    { "id": 7, "prompt": "Deploy" }
  ],
  "graph": "1>2 1>3 1>4 2,3,4>5 5>6 6>7"
}
```

| `error` | string? | Error message (if failed) |
| `sessionKey` | string? | Session key for agent tasks |

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

## Graph DSL

The `graph` string uses a space-separated lane syntax to encode task dependencies:

| Syntax    | Meaning                                              | Example   | Equivalent edges          |
| --------- | ---------------------------------------------------- | --------- | ------------------------- |
| `1>2`     | Task 1 must complete before task 2                   | `1>2`     | 2 → {1}                   |
| `1-3`     | Chain: 1 → 2 → 3 (sequential)                        | `1-3`     | 2 → {1}, 3 → {2}          |
| `1,3,4>5` | Group: tasks 1, 3, 4 must all complete before task 5 | `1,3,4>5` | 5 → {1, 3, 4}             |
| `1>2 3-5` | Multiple lanes separated by spaces                   | `1>2 3-5` | 2 → {1}, 4 → {3}, 5 → {4} |

**Examples:**

```
1>2          — 2 waits for 1
1-3          — chain: 1→2→3
1,3,4>5      — 5 waits for 1, 3, and 4
1>2 3-5      — two independent lanes
1>2 2>3 1>4  — diamond: 2 and 4 wait for 1, 3 waits for 2
```

Tasks with no dependencies can be omitted from the graph (they run immediately).

## Tips

- Agent tasks spawn subagents; respect `maxDepth` (hardcoded to 2) to avoid unbounded recursion.
- Use `concurrency` to limit parallel task execution.
- `failure_behavior: "pause"` on a task lets you `edit` and `retry` without restarting the whole workflow.
