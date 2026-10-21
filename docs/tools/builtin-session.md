# Session tools (builtin-session-query, builtin-subagent, builtin-session-list, builtin-session-send)

Four independent builtin tools for querying transcripts, spawning and managing subagents, listing sessions, and sending messages between sessions. Each is a separate, independently-callable tool (registered call names shown per section) — there is no single `builtin-session` tool.

---

## builtin-session-query

Registered as `session-query`. Search and paginate transcript messages across your agent's sessions.

### Parameters

| Param             | Type                | Required | Notes                                                     |
| ----------------- | ------------------- | -------- | --------------------------------------------------------- |
| `agent_id`        | string              | no       | Agent to query (defaults to caller)                       |
| `session_id`      | string              | no       | Narrow to a single session                                |
| `role`            | string \| string[]  | no       | Filter by message role(s)                                 |
| `query`           | string              | no       | Case-insensitive substring search on content              |
| `queryRegex`      | string              | no       | Regex search on content (mutually exclusive with `query`) |
| `limit`           | number              | no       | Max rows returned (1–100, default 50)                     |
| `offset`          | number              | no       | Pagination cursor (seq boundary)                          |
| `order`           | `"asc"` \| `"desc"` | no       | Sort order (default `"desc"`)                             |
| `metadataOnly`    | boolean             | no       | Return seq/role/session_id only (no content)              |
| `includeMetadata` | boolean             | no       | Attach `_meta` (timestamp, tokenCount, index)             |

### Examples

**Last 10 assistant messages in a session:**

```json
{
  "session_id": "agent:dev:discord:channel:123",
  "role": "assistant",
  "limit": 10
}
```

**Regex search across all sessions:**

```json
{ "queryRegex": "deploy\\s+prod", "limit": 5 }
```

**Metadata-only scan:**

```json
{
  "session_id": "agent:dev:discord:channel:123",
  "metadataOnly": true,
  "limit": 20
}
```

---

## builtin-subagent

Registered as `subagent`. Spawn and manage subagent sessions. Availability follows the `maxSpawnDepth` nesting gate: top-level sessions may spawn; a subagent session sees this tool only while its lineage depth is below `maxSpawnDepth` (default 1).

### Parameters

| Param    | Type   | Required | Notes                                                                                               |
| -------- | ------ | -------- | --------------------------------------------------------------------------------------------------- |
| `action` | string | yes      | One of: `spawn_one_shot`, `spawn_persistent`, `inspect`, `steer`, `abort`, `kill`, `wait`, `result` |

#### spawn_one_shot / spawn_persistent

| Param                 | Type     | Required | Notes                                                                             |
| --------------------- | -------- | -------- | --------------------------------------------------------------------------------- |
| `prompt`              | string   | yes      | Task prompt for the subagent                                                      |
| `respond_to`          | string   | no       | Session to deliver the result to (default: parent)                                |
| `internal`            | boolean  | no       | Set `false` to surface delivery to messaging platform                             |
| `background`          | boolean  | no       | Return immediately without waiting (one_shot only)                                |
| `delivery_mode`       | string   | no       | `inline` (default), `queue`, or `drop`                                            |
| `model_options`       | object   | no       | Override model settings                                                           |
| `enable_tools`        | string[] | no       | Tool IDs/globs (e.g. `kanban-*`) enabled for the subagent (added to defaults)     |
| `thread_id`           | string   | no       | Platform thread (persistent only)                                                 |
| `platform_user_id`    | string   | no       | Persistent only                                                                   |
| `reply_to_message_id` | string   | no       | Persistent only                                                                   |
| `inactivity_minutes`  | number   | no       | Inactivity window in minutes (persistent only; resets on each delivered response) |
| `contract`            | array    | no       | Contract mode entries (one_shot only): `{path, action, summary}` objects          |
| `judge`               | string   | no       | Decision model (`provider-id/model-name`) for judging contract fulfillment        |

##### contract (one_shot only)

Optional contract mode: a non-empty `contract` array makes the spawn verifiable
against explicit expectations. Each entry is `{ path, action, summary }` where
`action` is `create`, `update`, or `delete`, and `summary` is a brief
description of the expected change (no exact lines or contents).

When active:

- Every target must be inside a git repository at call time — otherwise the
  spawn fails with an error (no session is created).
- After the turn, a target that was not acted upon with its contractual action
  breaks the contract (no decision call for it).
- Otherwise the per-file `git diff` against the spawn-time HEAD is sent to the
  decision model in batches (`agents.contract.batchSize`, default 5). Deleted
  files are structural-only and never sent to the judge.
- Any per-file "yes" probability below `agents.contract.yesMinimum` (default
  `0.85`), any structural break, or any decision failure marks the contract
  unfulfilled.

The spawn response then carries an extra `contract` field: `{ fulfilled,
broken, error?, yesMinimum, entries, judged, violated, deletedSkipped,
baseline }`. Unset/empty `contract` leaves the mode inactive (no-op).

`judge` overrides the decision model for this spawn (`agents.contract.model`
or the decision config default applies when unset) and requires a non-empty
`contract`.

##### delivery_mode

Controls how subagent results are delivered to the parent session:

- **`inline`** (default): Inject the result into the parent's active tool loop via the steer channel. If no tool loop is active, falls back to `queue`.
- **`queue`**: Queue a new user turn in the `respond_to` session with the result.
- **`drop`**: Discard the result entirely. The parent can still retrieve it later via the `result` action using the returned `session_id`.

For foreground (blocking) one-shot spawns:

- `inline`: The reply is returned directly in the tool call result (existing behavior).
- `queue` / `drop`: The reply is suppressed from the synchronous response. Only `session_id` and metadata are returned.

##### Automatic Result Delivery

When a background one-shot or non-thread-bound persistent subagent completes its model turn, the result is automatically delivered as a user message to the `respond_to` session (defaults to the spawning parent). The delivered message includes:

- **Content**: `[Subagent completed] session_id: <child_id>\n\n<assistant text>`
- **Metadata**: `{ subagent_result: true, child_session_id: "<id>", mode: "one_shot" | "persistent" }`

This does **not** apply to:

- Synchronous one-shot spawns (the reply is returned inline in the tool result)
- Thread-bound persistent subagents (they deliver via their bound messaging surface)

#### steer

| Param                 | Type         | Required | Notes                       |
| --------------------- | ------------ | -------- | --------------------------- |
| `session_id`          | string       | yes      | Target session              |
| `prompt`              | string       | yes      | Steering message            |
| `delivery`            | `"internal"` | no       | Deliver as internal message |
| `platform_user_id`    | string       | no       |                             |
| `reply_to_message_id` | string       | no       |                             |

#### abort / kill

| Param        | Type   | Required | Notes          |
| ------------ | ------ | -------- | -------------- |
| `session_id` | string | yes      | Target session |

#### wait

| Param             | Type               | Required | Notes                             |
| ----------------- | ------------------ | -------- | --------------------------------- |
| `session_ids`     | string[]           | yes      | Sessions to wait on               |
| `timeout_ms`      | number             | no       | Max wait time                     |
| `mode`            | `"any"` \| `"all"` | no       | Wait for any or all               |
| `include_results` | boolean            | no       | Include final results in response |
| `max_chars`       | number             | no       | Truncate result content           |

#### result

| Param        | Type   | Required | Notes                   |
| ------------ | ------ | -------- | ----------------------- |
| `session_id` | string | yes      | Target session          |
| `max_chars`  | number | no       | Truncate result content |

#### inspect

No additional parameters. Returns info about the current session.

### Examples

**Fire-and-forget subagent:**

```json
{ "action": "spawn_one_shot", "prompt": "Summarize the last 5 PRs" }
```

**Background one-shot (returns immediately):**

```json
{ "action": "spawn_one_shot", "prompt": "Run the full test suite", "background": true }
```

**Persistent subagent in a thread:**

```json
{
  "action": "spawn_persistent",
  "prompt": "Monitor CI",
  "thread_id": "t-abc",
  "inactivity_minutes": 30
}
```

**Steer a running session:**

```json
{
  "action": "steer",
  "session_id": "agent:dev:subagent:abc-123",
  "prompt": "Focus on test failures"
}
```

**Wait for multiple subagents:**

```json
{
  "action": "wait",
  "session_ids": ["agent:dev:subagent:a", "agent:dev:subagent:b"],
  "mode": "all",
  "include_results": true
}
```

**Get a subagent's result:**

```json
{ "action": "result", "session_id": "agent:dev:subagent:abc-123" }
```

**Kill a session:**

```json
{ "action": "kill", "session_id": "agent:dev:subagent:abc-123" }
```

---

## builtin-session-list

Registered as `session-list`. List active sessions, optionally filtered by status or agent.

### Parameters

| Param      | Type   | Required | Notes                    |
| ---------- | ------ | -------- | ------------------------ |
| `status`   | string | no       | Filter by session status |
| `agent_id` | string | no       | Filter by agent id       |

### Examples

**List all sessions:**

```json
{}
```

**List running sessions for a specific agent:**

```json
{ "agent_id": "developer", "status": "running" }
```

---

## builtin-session-send

Registered as `session-send`. Send a message to a session or agent.

### Parameters

| Param                 | Type    | Required | Notes                                               |
| --------------------- | ------- | -------- | --------------------------------------------------- |
| `message`             | string  | yes      | Message content                                     |
| `session_id`          | string  | no\*     | Target session (mutually exclusive with `agent_id`) |
| `agent_id`            | string  | no\*     | Target agent (mutually exclusive with `session_id`) |
| `silent`              | boolean | no       | Suppress notifications                              |
| `platform_user_id`    | string  | no       | Sender context                                      |
| `reply_to_message_id` | string  | no       | Reply context                                       |
| `yieldMs`             | number  | no       | Reply window before yielding (default 30 s)         |
| `notify`              | boolean | no       | Deliver the delayed reply later (default: true)     |

\* Exactly one of `session_id` or `agent_id` is required.

### Yield & notify

A send blocks on the target's turn for at most the reply window — per-call
`yieldMs` (`0` blocks until the reply arrives, the legacy behavior), else
`runtime.sessionSendYieldMs` (or `SHOGGOTH_SESSION_SEND_YIELD_MS`), else 30 s.
A reply that lands in time is returned inline, exactly as before.

When the window expires the call returns a pending result
(`{ status: "pending", notify, notifyId?, targetSessionId, yieldMs, note }`)
instead of blocking, and — with `notify` (default `true`) — the pending call is
handed off to a notify handle. The yield itself posts a best-effort
`> 📨 Session-send yielded: waiting for reply from …` banner to the calling
session's bound surface, so the operator can see the call stopped blocking.

When the target's turn finally settles, the reply (shaped like the result a
blocking call would have returned) is delivered to the calling session:
**in-turn** through the steer channel when a turn is active — the
best-effort `> 📨 ✅ Session-send reply delivered in-turn` trace is folded
into that turn's own output (a standalone surface message only when no turn
output is live) — or **out of band**
otherwise, wrapped in the full emoji-stamped (📨) processing/terminal
banners, the same aesthetic as the background-exec notify banner. A failed
send (e.g. the target died mid-turn) is delivered the same way so the caller
is never left waiting on a handle that will never resolve.

`notify: false` skips the handle: the target's turn still runs (and posts to
its bound surface unless `silent`), but the reply is dropped — rely on the
target's own surface or `session-query` instead.

### Examples

**Send to a session:**

```json
{
  "session_id": "agent:dev:discord:channel:123",
  "message": "Build finished successfully"
}
```

**Send silently to an agent:**

```json
{
  "agent_id": "developer",
  "message": "Heads up: deploy complete",
  "silent": true
}
```
