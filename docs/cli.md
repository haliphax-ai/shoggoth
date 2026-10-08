# Shoggoth CLI Reference

Command-line interface for operating and inspecting a running Shoggoth [daemon](daemon.md). All commands communicate with the daemon over a Unix control socket (see [Daemon — Control Plane](daemon.md#control-plane)) and most require operator authentication.

Package: `@shoggoth/cli` · Binary: `shoggoth`

---

## Global Options

| Flag              | Description                   |
| ----------------- | ----------------------------- |
| `--version`, `-V` | Print version string and exit |
| `--help`, `-h`    | Print top-level help and exit |

Every subcommand also accepts `--help` / `-h` for its own usage text.

---

## Environment Variables

| Variable                               | Description                                                                                               |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `SHOGGOTH_OPERATOR_TOKEN`              | Operator bearer token. Required for all authenticated commands.                                           |
| `SHOGGOTH_CONTROL_SOCKET`              | Override the Unix socket path used to reach the daemon. Falls back to the `socketPath` in layered config. |
| `SHOGGOTH_CONFIG_DIR`                  | Override the config directory (default: built-in `LAYOUT.configDir`).                                     |
| `SHOGGOTH_SUBAGENT_INACTIVITY_MINUTES` | Inactivity window for persistent subagents in minutes (default 1440); resets on each delivered response.  |

---

## Session Targeting

Many commands accept a `<sessionUrn|agentId>` argument. You can pass either:

- A full session URN (e.g. `agent:main:discord:channel:123:uuid`)
- A bare agent ID (e.g. `main`) — resolves to that agent's bootstrap primary session via config lookup.

---

## Commands

### `shoggoth config`

Inspect the daemon's layered configuration.

```
shoggoth config show [--dynamic]
```

| Subcommand       | Description                                                                      |
| ---------------- | -------------------------------------------------------------------------------- |
| `show`           | Print the full effective (merged) config as JSON. Sensitive fields are redacted. |
| `show --dynamic` | Print only the dynamic config fragments (written at runtime).                    |

Requires: `SHOGGOTH_OPERATOR_TOKEN`

---

### `shoggoth session`

Session lifecycle, inspection, and control.

#### List sessions

```
shoggoth session list [status] [--agent <agentId>]
```

- `status` — optional filter (e.g. `active`, `terminated`).
- `--agent <agentId>` — filter to sessions belonging to a specific agent.

Output: JSON.

#### Send a message

```
shoggoth session send <sessionUrn|agentId> [--silent] <message...>
```

Injects a user-role message into the session and triggers a model turn.

- `--silent` — run the model turn but do not post the assistant reply to the bound messaging surface (internal delivery only).

#### Compact transcript

```
shoggoth session compact <sessionUrn|agentId>
```

Runs transcript compaction against the state DB for the target session. Uses the model client and [compaction policy](models.md#transcript-compaction) from config. Output: JSON with `{ compacted, messageCount }`.

#### Context segment management

```
shoggoth session context new <sessionUrn|agentId>
shoggoth session context reset <sessionUrn|agentId>
```

- `new` — create a new context segment for the session.
- `reset` — reset the current context segment.

#### Inspect session

```
shoggoth session inspect <sessionUrn|agentId>
```

Returns the session row and child subagent information. Output: JSON.

#### Session status

```
shoggoth session status <sessionUrn|agentId>
```

Returns session status, stats, and model info. Output: JSON.

#### Steer (extra model turn)

```
shoggoth session steer <sessionUrn|agentId> <surface|internal> <prompt...>
```

Triggers an additional model turn with the given prompt.

- `surface` — reply is posted to the bound messaging channel.
- `internal` — reply stays internal (not posted).

#### Abort in-flight turn

```
shoggoth session abort <sessionUrn|agentId>
```

Aborts a currently running model turn for the session.

#### Kill session

```
shoggoth session kill <sessionUrn|agentId>
```

Terminates the session and performs cleanup.

#### Model selection

```
shoggoth session model <sessionUrn|agentId>                     # Show current model
shoggoth session model <sessionUrn|agentId> <provider/model>    # Set model (e.g. openai/gpt-4o)
shoggoth session model <sessionUrn|agentId> --clear             # Reset to default
```

Displays a human-readable summary: session ID, current selection, and effective provider/model. See [Models — Configuration](models.md#configuration--model-selection) for how model selection works.

---

### `shoggoth subagent`

Spawn child agent sessions.

```
shoggoth subagent spawn [--model-options <json>] one_shot <parentUrn|agentId> <prompt...>
shoggoth subagent spawn [--model-options <json>] persistent <parentUrn|agentId> [threadId] <prompt...>
```

| Mode         | Description                                                                                                                                                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `one_shot`   | Internal one-shot child session. Runs a single turn and terminates.                                                                                                                                                                                    |
| `persistent` | Long-lived child session. Optional numeric `threadId` binds replies to a platform thread; omit for agent-to-agent only. Auto-terminated after the inactivity window (`SHOGGOTH_SUBAGENT_INACTIVITY_MINUTES`, in minutes) without a delivered response. |

- `--model-options <json>` — JSON object merged as a model options overlay. Child inherits the parent's `model_selection` by default.

Output: JSON.

---

### `shoggoth hitl`

Human-in-the-loop approval queue management.

#### List pending actions

```
shoggoth hitl list [sessionId]
```

Lists all pending HITL actions. Optionally filter by session URN.

#### Get a pending action

```
shoggoth hitl get <id>
```

Fetch a single pending HITL row by ID.

#### Approve / Deny

```
shoggoth hitl approve <id>
shoggoth hitl deny <id>
```

Approve or deny a pending tool invocation.

#### Clear pending actions

```
shoggoth hitl clear <agentId|all> [--session <sessionURN>] [--noauto]
```

- `<agentId|all>` — target agent, or `all` for every agent.
- `--session <sessionURN>` — scope to a single session; leaves auto-approve state unchanged.
- `--noauto` — clear pending rows only; preserve session and agent auto-approve settings.

Output: JSON.

---

### `shoggoth mcp`

MCP (Model Context Protocol) helpers.

```
shoggoth mcp cancel <sessionId> <sourceId> <requestId>
```

Cancels a streamable HTTP MCP JSON-RPC request by its numeric request ID. Output: JSON.

---

### `shoggoth queue`

Turn queue inspection and manipulation.

All subcommands require `--session <id>`.

#### List queued turns

```
shoggoth queue list --session <id> [--priority system|user|all]
```

Displays a formatted table: Index, Priority, Label, Enqueued timestamp.

#### Remove entries

```
shoggoth queue remove --session <id> [--priority system|user|all] --index N
shoggoth queue remove --session <id> [--priority system|user|all] --range N-M
shoggoth queue remove --session <id> [--priority system|user|all] --count N
```

Remove by single index, inclusive range, or count from the front.

#### Clear queue

```
shoggoth queue clear --session <id> [--priority system|user|all]
```

Remove all entries (optionally filtered by priority).

---

### `shoggoth procman`

Managed process control (daemon child processes).

#### List processes

```
shoggoth procman list
```

Displays a formatted table: ID, State, PID, Uptime, Restarts, Owner.

#### Restart a process

```
shoggoth procman restart <id>
```

#### Stop a process

```
shoggoth procman stop <id>
```

---

### `shoggoth elevation`

Permission elevation grants for sessions.

#### Grant elevation

```
shoggoth elevation grant <session-id> [--duration 5m]
```

- Duration format: `Ns`, `Nm`, `Nh` (e.g. `5m`, `300s`, `1h`). Bare numbers are treated as seconds.
- Default: 5 minutes. Maximum: 30 minutes.

#### Revoke elevation

```
shoggoth elevation revoke <session-id>                # Revoke all grants for session
shoggoth elevation revoke --id <grant-id>             # Revoke a specific grant
```

Output: JSON.

---

### `shoggoth retention`

Data retention job runner.

```
shoggoth retention run
```

Opens the state DB, runs migrations, executes all configured retention jobs, and prints a JSON summary. This operates directly on the database (not via control socket), so it can run offline.

---

### `shoggoth events`

Event subsystem tooling.

#### Dead-letter queue

```
shoggoth events dlq [limit]
```

Lists dead-letter events from the state DB. Default limit: 100. Operates directly on the database.

Output: JSON `{ dead: [...] }`.

---

### `shoggoth skills`

Skill discovery from configured scan roots.

#### List all skills

```
shoggoth skills list
```

Output: JSON array of `{ id, title, path, enabled }`.

#### Resolve skill path

```
shoggoth skills path <id>
```

Prints the absolute filesystem path to the skill's markdown file.

#### Read skill content

```
shoggoth skills read <id>
```

Output: JSON `{ path, content }`.

---

### `shoggoth system`

System-level daemon operations.

#### Health check

```
shoggoth system health
```

Runs health checks against the daemon via the control socket. Does not require authentication (no sensitive data returned), but will use `SHOGGOTH_OPERATOR_TOKEN` if set.

Output: JSON. Exit code 0 if healthy and ready, 1 otherwise.

---

## Authentication Model

Most commands require `SHOGGOTH_OPERATOR_TOKEN` to be set. The token is sent as `{ kind: "operator_token", token }` with each control socket request. Exceptions:

- `shoggoth system health` — exempt from auth.
- `shoggoth retention run` and `shoggoth events dlq` — operate directly on the state DB file, bypassing the control socket entirely.

## Communication

Commands fall into two categories:

1. **Control socket commands** — most commands communicate with the running daemon over a Unix domain socket (`SHOGGOTH_CONTROL_SOCKET` or `config.socketPath`). These require the daemon to be running.
2. **Direct DB commands** — `retention run` and `events dlq` open the state SQLite database directly, run migrations, and operate offline. These do not require a running daemon.

---

## See Also

- [Daemon](daemon.md) — the runtime process the CLI controls
- [Models](models.md) — model selection and compaction referenced by `session model` and `session compact`
- [Shared](shared.md) — config schema, session URN format, filesystem layout
- [Platform Discord](platform-discord.md) — slash commands provide an alternative to CLI for some operations
