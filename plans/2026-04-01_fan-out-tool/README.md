# Fan-out Tool

A tool for breaking projects into tasks and executing them via subagents while keeping context tight. Spawns subagents both sequentially and in parallel according to a task dependency graph. Uses the Shoggoth process manager to run a long-lived server that handles the lifecycle of task workflows.

## Phase 1 — Data Model & Graph Engine

The foundation. Nothing runs without this.

- Define the task list data model
  - Task ID, prompt, status enum (`pending`, `in_progress`, `done`, `failed`, `paused`), dependencies, failure behavior, failure notification config, start/end timestamps, session key, output/error storage
- Implement the dependency graph DSL parser
  - `1>2` — dependency
  - `1-3` — dependency chain
  - `1,3,4` — dependency group
  - `1>2 3-5 6,7>8` — space-separated lanes
- Graph validation
  - Cycle detection → error
  - Dead-end detection → error
  - Overlapping sequences → warning, flatten and proceed
- Template string parser for `{{task:N:output}}` and `{{task:N:success}}`
  - Validate references only point to direct or transitive dependencies
- Spawn depth check (error if agent is at max depth, effectively 2)
- Unit tests for graph parsing, validation, and template resolution

**Deliverable:** A library module that can parse, validate, and represent a task workflow in memory. No execution yet.

## Phase 2 — Procman Server & Core Orchestration Loop

Wire up the long-lived server and get tasks actually running.

- Shoggoth procman integration: register the fan-out orchestrator as a managed long-lived process
- Implement `start` action
  - Accept task list + dependency graph + options (runtime limit, polling interval)
  - Create tracked workflow, assign task list ID
  - Persist state to disk (JSON or SQLite) so workflows survive procman restarts
- State persistence
  - Write workflow state (task list, graph, statuses, outputs, timestamps) to disk on every state transition
  - On orchestrator startup, scan for incomplete workflows and resume them
  - Store state per task list ID in a known directory
- Orchestration loop
  - Walk the dependency graph, identify ready tasks (all deps satisfied)
  - Spawn subagents with `replyTo` set to calling agent session and `timeout` set to task runtime limit
  - Template string resolution at spawn time — inject completed dependency outputs into downstream task prompts
- Polling loop on configured interval (default 10s)
  - Check subagent session status
  - Update task statuses and timestamps
  - Persist updated state to disk after each poll cycle
- State transitions: `pending` → `in_progress` → `done`/`failed`
- Workflow completion detection (all tasks terminal) → notify parent agent
- Return task list ID to calling agent immediately after initial spawn wave

**Deliverable:** A working `start` action that can execute a full dependency graph end-to-end with the happy path (no failures), with state persisted to disk and recoverable across restarts.

## Phase 3 — Status Messaging

Make it visible.

- Post initial status message on workflow creation, store message ID
- Format status message per spec:
  - Emoji indicators: ⏳ pending, 🚀 in progress, ⏸️ paused, ✅ completed, ❌ failed
  - `[1,2]` dependency notation
  - `(1m5s)` duration notation
- Edit status message on each poll cycle with updated statuses/durations
- Platform capability detection
  - If edit fails or isn't supported, switch to repost mode with abbreviated format and lengthened update interval
- Summarization message on workflow completion
  - Total duration, pass/fail counts, list of failed tasks with durations

**Deliverable:** Live-updating status messages that work across platforms.

## Phase 4 — Failure Handling & Notifications

Make it resilient.

- Per-task failure behavior
  - `abort` — kill remaining tasks, fail workflow
  - `pause` — halt orchestrator, let in-flight tasks finish
  - `continue` — mark failed, proceed with graph where possible
- Per-task failure notification routing
  - `silent` — no notification
  - `notify parent` — notify calling agent
  - `notify <agent/session ID>` — notify specific target
- Spawn error handling: if subagent spawn fails, pause orchestrator and notify parent
- Runtime limit enforcement: kill subagent sessions that exceed their timeout, mark as failed

**Deliverable:** Failure modes work correctly and notifications route to the right place.

## Phase 5 — Control Plane Actions

Give the calling agent levers.

- `abort` — kill all active subagents for a task list, stop orchestrator, update status message
- `pause` — set orchestrator to paused state (in-flight tasks finish, no new spawns)
- `resume` — resume orchestrator from paused state, spawn next ready tasks
- `status` — return task list with statuses and durations for a given task list ID
- `list` — return all task lists for the current agent chain (scoped by default, configurable)
- `post` — repost the current status message for a given task list ID
- `edit` — modify task list items that are not currently `in_progress`
  - Update task prompt, failure behavior, failure notification config, or runtime limit
  - Reject edits to tasks with status `in_progress` (error with message indicating the task must be paused or completed first)
  - Persist changes to disk immediately
  - If the workflow is active, the orchestrator picks up changes on the next poll cycle
- `retry` — redrive a specific failed task: re-spawn it, then resume the graph for pending/failed downstream tasks
  - Support `cascade` flag to also re-spawn completed downstream tasks

**Deliverable:** Full control plane per the tool actions spec.

## Phase 6 — Retention & Hardening

Clean up and tighten.

- `retention run` control plane op
  - Prune completed task lists older than 48 hours
  - Prune paused task lists older than 7 days
  - Clean up associated disk state files
- Hook retention into a scheduled interval or expose as a manual trigger
- Edge case hardening
  - Race conditions in status transitions
  - Orphaned subagent sessions
  - Concurrent workflow validation (multiple active task lists)
- Integration tests for full workflow lifecycle including failure/retry/resume paths

**Deliverable:** Production-ready lifecycle management.
