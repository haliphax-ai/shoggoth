# Workflow Engine Reference

The workflow package orchestrates parallel and sequential subagent workflows. It is integrated into the [daemon](daemon.md#workflow-engine) and exposed to agents via the `builtin-workflow` tool. It breaks work into tasks arranged in a dependency graph, executes them with concurrency control, tracks status with live-updating messages, and provides a full control plane for pause/resume/retry/abort.

---

## Core Concepts

### Workflow (TaskList)

A workflow is a named collection of tasks plus a dependency graph. It is the top-level unit of execution.

| Field               | Type              | Description                                                          |
| ------------------- | ----------------- | -------------------------------------------------------------------- |
| `id`                | `string`          | UUID, auto-generated on start                                        |
| `name`              | `string`          | Human-readable name                                                  |
| `tasks`             | `TaskState[]`     | Array of task runtime states                                         |
| `graph`             | `DependencyGraph` | `Map<number, Set<number>>` — task ID → set of dependency task IDs    |
| `pollingIntervalMs` | `number`          | How often the orchestrator polls in-progress tasks                   |
| `createdAt`         | `number`          | Epoch ms                                                             |
| `concurrency`       | `number?`         | Max simultaneously in-progress tasks. `0` or `undefined` = unlimited |
| `runtimeLimitMs`    | `number?`         | Default per-task runtime limit in ms                                 |

### Task Status Lifecycle

```
pending → in_progress → done
                      → failed
         → skipped (dependency was skipped or gate returned false)
```

Valid statuses: `pending`, `in_progress`, `done`, `failed`, `paused`, `skipped`.

Status transitions are forward-only. Terminal states (`done`, `failed`, `skipped`) cannot transition to anything else (except via explicit retry reset).

---

## Task Types

Every task has a `kind` discriminator. All kinds share these base fields:

| Field                 | Type                  | Default          | Description                                                                                     |
| --------------------- | --------------------- | ---------------- | ----------------------------------------------------------------------------------------------- |
| `id`                  | `number`              | required         | Unique task number (1-based)                                                                    |
| `title`               | `string?`             | —                | Display title for status posts (max 60 chars). Falls back to truncated prompt/label             |
| `failureBehavior`     | `FailureBehavior`     | `"continue"`     | What to do when this task fails: `abort`, `pause`, or `continue`                                |
| `failureNotification` | `FailureNotification` | `"silent"`       | Who to notify on failure                                                                        |
| `runtimeLimitMs`      | `number?`             | workflow default | Per-task runtime limit override in ms                                                           |
| `outputTemplate`      | `string?`             | —                | Reshape task output before downstream consumption. Supports `{{self.output}}`, `{{self.error}}` |

### agent

Spawns a subagent session with a prompt. This is the default kind.

| Field    | Type     | Description                                                                                            |
| -------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `prompt` | `string` | The prompt sent to the subagent. May contain `{{task:N:output}}` or `{{task:N:success}}` template refs |

Agent tasks are the only asynchronous task type — they are spawned as [subagent sessions](daemon.md#subagents) and polled until completion. The orchestrator checks for the `ERROR:TASK_FAILED` marker in agent output to detect self-reported failures.

### tool

Invokes a tool directly (no subagent session).

| Field  | Type                      | Description                                         |
| ------ | ------------------------- | --------------------------------------------------- |
| `tool` | `string`                  | Tool name                                           |
| `args` | `Record<string, unknown>` | Tool arguments. String values support template refs |

Tool args are recursively resolved — template refs in nested objects and arrays are expanded. Requires a `ToolExecutor` adapter (see [MCP Integration — Built-in Tools](mcp-integration.md#built-in-shoggoth-tools) for the tool catalog).

### gate

Evaluates a boolean condition expression synchronously. If the condition is false, the gate's output is `"skip"` and all transitive dependents are marked `skipped`.

| Field       | Type     | Description        |
| ----------- | -------- | ------------------ |
| `condition` | `string` | Boolean expression |

#### Gate Expression Language

The gate evaluator is a custom safe expression parser (no `eval`). Supported syntax:

- **Task references:** `{{task:N:success}}`, `{{task:N:output}}` (template syntax) or `task.N.success`, `task.N.output` (dot notation — templates are normalized to this)
- **Operators:** `==`, `!=`, `&&`, `||`, `!`
- **String containment:** `task.1.output contains "keyword"`
- **Literals:** `true`, `false`, `"string"`, `'string'`
- **Grouping:** parentheses `()`

Example conditions:

```
task.1.success == true
task.1.output contains "approved" && task.2.success
!(task.3.success) || task.4.output == "fallback"
```

### transform

Pure string interpolation — no I/O, no subagent. Resolves template refs in a template string and stores the result as output.

| Field      | Type     | Description                                                          |
| ---------- | -------- | -------------------------------------------------------------------- |
| `template` | `string` | Template string with `{{task:N:output}}` / `{{task:N:success}}` refs |

### message

Posts a message to a channel or session.

| Field     | Type      | Description                                                          |
| --------- | --------- | -------------------------------------------------------------------- |
| `message` | `string`  | Message body. Supports template refs                                 |
| `channel` | `string?` | Target channel/session. Defaults to the workflow's `replyTo` session |

Requires a `MessagePoster` adapter.

---

## Dependency Graph DSL

The graph is specified as a string using a compact DSL. Lanes are space-separated.

| Syntax    | Meaning                                          | Example                   |
| --------- | ------------------------------------------------ | ------------------------- |
| `A>B`     | Task A must complete before task B               | `1>2`                     |
| `A-B`     | Chain from A to B (all integers in range)        | `1-4` = `1→2→3→4`         |
| `A,B>C`   | Group: tasks A and B must both complete before C | `1,3>5`                   |
| `A>B C-E` | Multiple lanes (space-separated)                 | Two independent subgraphs |

Chains expand to sequential dependencies: `1-4` creates edges `1→2`, `2→3`, `3→4`.

The graph is validated on workflow start:

- All referenced task IDs must exist in the task list
- Cycle detection via iterative DFS with coloring (throws on cycle with path)
- Template refs are validated to ensure they only reference direct or transitive dependencies

---

## Template System

Prompts, templates, messages, and tool args can reference outputs from upstream tasks:

| Template             | Resolves To                                              |
| -------------------- | -------------------------------------------------------- |
| `{{task:N:output}}`  | The `output` string of task N (empty string if none)     |
| `{{task:N:success}}` | `"true"` if task N status is `done`, `"false"` otherwise |

Templates are validated at workflow start — a task can only reference its own direct or transitive dependencies. This prevents referencing tasks that haven't completed yet.

### Output Templates

Any task can define `outputTemplate` to reshape its output before downstream tasks consume it:

```
{{self.output}}   → the task's raw output
{{self.error}}    → the task's error string
```

Output templates are applied once after a task completes with status `done`.

---

## Orchestrator

The `Orchestrator` class is the execution engine. It manages the lifecycle of a single workflow.

### Tick Cycle

Each tick performs these steps in order:

1. **Poll in-progress tasks** — check subagent sessions for completion/failure
2. **Enforce runtime limits** — timeout tasks that exceed their limit (abort + kill)
3. **Handle failures** — apply failure behaviors (abort workflow, pause, or continue)
4. **Mark blocked tasks** — pending tasks with failed dependencies are marked `failed` ("blocked: dependency failed"); pending tasks with skipped dependencies are marked `skipped`
5. **Spawn ready tasks** — if not paused, start tasks whose dependencies are all `done` (respecting concurrency cap)
6. **Apply output templates** — reshape outputs of newly completed tasks
7. **Persist state** — save workflow to disk
8. **Dispatch failure notifications** — send notifications for newly failed tasks
9. **Check completion** — if all tasks are terminal and not paused, finalize the workflow

### Concurrency Control

When `concurrency` is set (> 0), the orchestrator counts current `in_progress` tasks before spawning. If the count meets or exceeds the cap, no new tasks are spawned until a slot opens.

### Spawn Depth Limiting

Workflows check `currentDepth < maxDepth` before starting. This prevents infinite recursive subagent spawning.

### Polling

The orchestrator runs on a timer-based polling loop (`startPolling` / `stopPolling`). Status message updates run on a separate independent timer at the same interval, decoupled from tick cycle latency.

---

## Failure Handling

### Per-Task Failure Behavior

Each task specifies what happens when it fails:

| Behavior   | Effect                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------- |
| `continue` | Default. The workflow continues. Downstream tasks that depend on the failed task are marked as blocked/failed |
| `pause`    | The orchestrator pauses — in-flight tasks continue running, but no new tasks are spawned. Resume to continue  |
| `abort`    | All in-progress tasks are killed, all pending tasks are marked failed. The workflow terminates immediately    |

### Failure Notifications

| Config                                       | Effect                                                   |
| -------------------------------------------- | -------------------------------------------------------- |
| `"silent"`                                   | Default. No notification                                 |
| `{ kind: "notify-parent" }`                  | Send failure message to the workflow's `replyTo` session |
| `{ kind: "notify-target", targetId: "..." }` | Send failure message to a specific session/channel       |

### Blocked Task Propagation

When a task fails with `continue` behavior:

- Direct dependents with all deps met except the failed one → marked `failed` with error `"blocked: dependency failed"`
- This cascades transitively through the graph

### Skipped Task Propagation

When a gate evaluates to false:

- The gate itself completes as `done` with output `"skip"`
- All transitive dependents are marked `skipped`
- Pending tasks with any skipped dependency are also marked `skipped`

### Self-Reported Failure

Agent tasks can signal failure by including the literal string `ERROR:TASK_FAILED` in their output. The orchestrator detects this marker and marks the task as `failed` even though the subagent session completed successfully.

### Runtime Limits

Tasks that exceed their runtime limit (per-task override or workflow default) are:

1. Aborted via `SpawnAdapter.abortTask()` (cancels in-flight model turn)
2. Killed via `KillAdapter.kill()` (terminates the session)
3. Marked `failed` with error `"timeout: task exceeded runtime limit of Xms"`

---

## Control Plane

The `ControlPlane` class provides operational control over running and persisted workflows.

### Actions

| Action      | Description                                                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `abort`     | Kill all sessions, mark all non-terminal tasks as failed, stop polling, post summary                                                                                            |
| `pause`     | Set paused flag — in-flight tasks continue, no new spawns                                                                                                                       |
| `resume`    | Clear paused flag — ready tasks spawn on next tick                                                                                                                              |
| `status`    | Return current workflow state (in-memory or from disk)                                                                                                                          |
| `list`      | List all workflows from disk with summary info (status counts)                                                                                                                  |
| `post`      | Repost the status message for a workflow                                                                                                                                        |
| `edit`      | Modify a task definition (prompt, failure_behavior, failure_notification, runtime_limit_ms). Rejects edits to `in_progress` tasks                                               |
| `retry`     | Reset a failed/done task to pending, reset blocked downstream tasks, resume if paused, restart polling if stopped. With `cascade: true`, also resets completed downstream tasks |
| `wait`      | Block until all tasks are terminal (with timeout). Used programmatically                                                                                                        |
| `retention` | Prune old workflows from disk and memory                                                                                                                                        |

### Retry Mechanics

When retrying a task:

1. The target task is reset: status → `pending`, error/output/timestamps/sessionKey cleared
2. All downstream tasks (transitive dependents) that are `failed` are also reset
3. If `cascade: true`, downstream `done` tasks are also reset
4. The orchestrator is unpaused and its completed flag is cleared
5. Polling is restarted if it was stopped

---

## State Persistence

Workflows are persisted as JSON files in the configured `stateDir` (`{workflowId}.json`). The graph is serialized as `{ [taskId: string]: number[] }`.

State is saved:

- After initial task spawn wave
- After every tick cycle
- After control plane operations (pause, resume, edit, retry)

On startup, `WorkflowServer.resume()` loads all incomplete workflows from disk and restarts their polling loops.

---

## Status Messages

The `StatusManager` posts and edits a live status message for each workflow via a `MessageAdapter` (platform-agnostic interface for post/edit).

### Status Message Format

```
**Task workflow:** my-workflow
**Concurrency:** 3

⏳ 1 - Analyze codebase
🚀 2 [1] - Write tests (1m5s)
✅ 3 [1] - Update docs (45s)
❌ 4 [2,3] - Deploy (blocked: dependency failed)
⏭️ 5 [4] - Notify team
```

Status emoji: ⏳ pending, 🚀 in_progress, ⏸️ paused, ✅ done, ❌ failed, ⏭️ skipped

Each task line shows: `{emoji} {id}[{deps}] - {title} ({duration})`

### Summary Message

Posted on workflow completion:

```
**Task workflow complete:** my-workflow
⏱️ **Duration:** 5m30s
✅ **Completed:** 4/5
❌ **Failed:** 1/5
- 4 - Deploy (2m10s)
```

---

## Retention

Automatic cleanup of old workflow state files.

| Category                                                  | Default Max Age |
| --------------------------------------------------------- | --------------- |
| Completed workflows (all tasks terminal)                  | 48 hours        |
| Paused workflows (has pending tasks, nothing in-progress) | 7 days          |

Age is measured from the latest `completedAt` timestamp (for completed workflows) or `createdAt` (for paused workflows).

Retention can run on-demand via the control plane or on a scheduled interval via `startRetentionSchedule()`. Pruned workflows are also removed from the in-memory orchestrator map.

---

## Hardening

### Status Transition Guards

`isValidTransition(from, to)` enforces forward-only status progression. Terminal states cannot transition. `guardedTransition(task, newStatus)` applies the check and returns whether the transition was applied.

### Tick Lock

`createTickLock()` provides a simple async mutex that prevents overlapping tick executions. If a tick is already running, subsequent calls are skipped (not queued).

### Orphan Detection

`detectOrphans(wf, poller)` checks all `in_progress` tasks by polling their sessions. If a poll throws (session gone), the task is marked `failed` with error `"orphaned: subagent session no longer exists"`. `detectAndPersistOrphans()` additionally saves the workflow state if orphans are found.

---

## Tool Interface

The workflow engine is exposed as a single tool called `workflow` with an `action` discriminator.

### start

```json
{
  "action": "start",
  "name": "my-workflow",
  "tasks": [
    { "id": 1, "prompt": "Do step one" },
    {
      "id": 2,
      "prompt": "Do step two using {{task:1:output}}",
      "failure_behavior": "abort"
    },
    { "id": 3, "kind": "gate", "condition": "task.1.success == true" },
    { "id": 4, "kind": "transform", "template": "Results: {{task:1:output}}" },
    { "id": 5, "kind": "message", "message": "Done: {{task:4:output}}" },
    {
      "id": 6,
      "kind": "tool",
      "tool": "builtin-fetch",
      "args": { "url": "https://example.com" }
    }
  ],
  "graph": "1-2 1>3 3>4 4>5 1>6",
  "reply_to": "session-id",
  "concurrency": 3,
  "polling_interval_ms": 10000,
  "runtime_limit_ms": 600000
}
```

### Control actions

| Action      | Required Fields                                                                              |
| ----------- | -------------------------------------------------------------------------------------------- |
| `abort`     | `workflow_id`                                                                                |
| `pause`     | `workflow_id`                                                                                |
| `resume`    | `workflow_id`                                                                                |
| `wait`      | `workflow_id`, optional `wait_timeout_ms`                                                    |
| `status`    | `workflow_id`                                                                                |
| `list`      | (optional `agent_chain_id`)                                                                  |
| `post`      | `workflow_id`                                                                                |
| `edit`      | `workflow_id`, `task_id`, plus optional `prompt`, `failure_behavior`, `failure_notification` |
| `retry`     | `workflow_id`, `task_id`, optional `cascade`                                                 |
| `retention` | (none)                                                                                       |

---

## Architecture Summary

```
Tool Call (workflow)
  → WorkflowToolHandler     — validates args, converts to internal types
    → WorkflowServer         — creates Orchestrator instances, manages lifecycle
      → Orchestrator          — tick loop: poll, spawn, fail, complete
        → SpawnAdapter        — creates subagent sessions (agent tasks)
        → PollAdapter         — checks subagent session status
        → ToolExecutor        — runs tool tasks directly
        → MessagePoster       — delivers message task content
        → KillAdapter         — terminates sessions
        → StatusManager       — posts/edits live status messages
          → MessageAdapter    — platform-agnostic post/edit
    → ControlPlane            — abort/pause/resume/retry/edit/list/retention
      → State (disk)          — JSON persistence in stateDir
```

The `WorkflowServer` also handles resume on startup by loading incomplete workflows from disk and restarting their orchestrators.

---

## See Also

- [Daemon](daemon.md) — hosts the workflow engine and wires adapters
- [MCP Integration](mcp-integration.md) — tool catalog used by `tool` task type
- [CLI](cli.md) — no direct workflow CLI commands yet; control via the `builtin-workflow` tool
