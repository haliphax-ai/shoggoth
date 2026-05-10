# builtin-session

Tools for querying transcripts, spawning/managing subagents, listing sessions, and sending messages to sessions.

---

## session-query

Search and paginate transcript messages across your agent's sessions.

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

## subagent

Spawn and manage subagent sessions. Only available to top-level (non-subagent) sessions.

### Parameters

| Param    | Type   | Required | Notes                                                                                               |
| -------- | ------ | -------- | --------------------------------------------------------------------------------------------------- |
| `action` | string | yes      | One of: `spawn_one_shot`, `spawn_persistent`, `inspect`, `steer`, `abort`, `kill`, `wait`, `result` |

#### spawn_one_shot / spawn_persistent

| Param                 | Type    | Required | Notes                                                 |
| --------------------- | ------- | -------- | ----------------------------------------------------- |
| `prompt`              | string  | yes      | Task prompt for the subagent                          |
| `respond_to`          | string  | no       | Session to deliver the result to (default: parent)    |
| `internal`            | boolean | no       | Set `false` to surface delivery to messaging platform |
| `background`          | boolean | no       | Return immediately without waiting (one_shot only)    |
| `delivery_mode`       | string  | no       | `inline` (default), `queue`, or `drop`                |
| `model_options`       | object  | no       | Override model settings                               |
| `thread_id`           | string  | no       | Platform thread (persistent only)                     |
| `platform_user_id`    | string  | no       | Persistent only                                       |
| `reply_to_message_id` | string  | no       | Persistent only                                       |
| `lifetime_ms`         | number  | no       | Auto-kill timeout (persistent only)                   |

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
  "lifetime_ms": 300000
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

## session-list

List active sessions, optionally filtered by status or agent.

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

## session-send

Send a message to a session or agent.

### Parameters

| Param                 | Type    | Required | Notes                                               |
| --------------------- | ------- | -------- | --------------------------------------------------- |
| `message`             | string  | yes      | Message content                                     |
| `session_id`          | string  | no\*     | Target session (mutually exclusive with `agent_id`) |
| `agent_id`            | string  | no\*     | Target agent (mutually exclusive with `session_id`) |
| `silent`              | boolean | no       | Suppress notifications                              |
| `platform_user_id`    | string  | no       | Sender context                                      |
| `reply_to_message_id` | string  | no       | Reply context                                       |

\* Exactly one of `session_id` or `agent_id` is required.

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
