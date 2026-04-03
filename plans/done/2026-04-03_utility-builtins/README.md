---
date: 2026-04-03
completed: 2026-04-03
---

# Utility builtins — fetch, fs ops, directory listing, KV store, timers

## Summary

Add five new builtin tool families that eliminate the most common `exec` workarounds agents rely on today: HTTP fetch, directory listing, file operations (move/copy/delete/stat/chmod), a structured key-value store, and deferred/scheduled actions. Each tool is policy-aware, sandboxed, and avoids the shell injection surface of raw exec.

## Motivation

Agents currently shell out via `exec` for basic operations that should be first-class builtins. This has real costs:

- **Security:** `exec curl ...` and `exec ls ...` bypass tool-level policy gating. There's no way to allow "fetch this URL" without also allowing arbitrary shell commands.
- **Ergonomics:** simple operations like listing a directory or copying a file burn multiple tool calls and require the model to construct shell commands correctly.
- **Reliability:** shell commands are brittle — quoting, escaping, platform differences. A structured tool with typed parameters is harder to misuse.
- **Auditability:** a `builtin-fetch` call with explicit URL/method/headers is trivially auditable. A raw `exec` with a curl command buried in argv is not.

The KV store and timer tools address a different gap: agents need lightweight persistence and scheduling primitives that don't exist today. Markdown memory is great for notes but wrong for flags, counters, and preferences. Heartbeats require operator configuration — agents can't self-schedule.

## Design

### 1. `builtin-fetch` — HTTP client

A structured HTTP client tool with explicit parameters for method, URL, headers, body, and response handling.

```ts
interface FetchToolParams {
  /** HTTP method. Default: GET. */
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
  /** Target URL. Required. */
  readonly url: string;
  /** Request headers as key-value pairs. */
  readonly headers?: Record<string, string>;
  /** Request body. String or JSON object. */
  readonly body?: string | Record<string, unknown>;
  /** When true, return response body as base64 instead of text. For binary responses. */
  readonly binary?: boolean;
  /** Maximum response body bytes to return. Default: 1MB. Truncates with a marker. */
  readonly maxResponseBytes?: number;
  /** Request timeout in ms. Default: 30000. */
  readonly timeoutMs?: number;
}

interface FetchToolResult {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Record<string, string>;
  /** Response body as text (or base64 when binary: true). Truncated if over maxResponseBytes. */
  readonly body: string;
  readonly truncated: boolean;
  readonly bodyBytes: number;
}
```

**Policy integration:** The policy engine can gate fetch calls by URL pattern, method, or domain. A new policy action `fetch` with resource = URL enables fine-grained control. Denied requests return a policy error result, not a throw.

**Security:**
- No redirect following by default. Optional `followRedirects: true` with a cap (default 5).
- Request body size capped (default 10MB).
- Response body capped and truncated (default 1MB returned to model).
- `Authorization` and `Cookie` headers are audit-logged but not redacted in tool results (the model needs them for context). Policy can block sensitive header patterns.
- Private/internal IP ranges (127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, ::1) are blocked by default. Configurable via `fetch.allowPrivateIps` (boolean, default `false`) and `fetch.privateIpAllowlist` (array of CIDR ranges or hostnames) in the runtime config. When `allowPrivateIps` is `true`, all private ranges are permitted. When `false`, only entries in `privateIpAllowlist` are allowed through.

**Content-Type handling:**
- When `body` is an object and no `Content-Type` header is set, auto-set `application/json` and JSON-serialize.
- When response `Content-Type` is JSON, parse and pretty-print in the result for readability.

### 2. `builtin-ls` — Directory listing

A structured directory listing tool that replaces `exec ls`.

```ts
interface LsToolParams {
  /** Directory path (workspace-relative). Default: "." */
  readonly path?: string;
  /** Include entries starting with ".". Default: false. */
  readonly all?: boolean;
  /** Recurse into subdirectories. Default: false. */
  readonly recursive?: boolean;
  /** Maximum depth when recursive. Default: 5. */
  readonly maxDepth?: number;
  /** Glob pattern to filter entries. Applied to relative paths. */
  readonly glob?: string;
  /** Include file metadata (size, mtime, type). Default: false. */
  readonly stat?: boolean;
  /** Maximum entries to return. Default: 1000. */
  readonly limit?: number;
}

interface LsEntry {
  /** Relative path from the listed directory. */
  readonly path: string;
  /** "file" | "directory" | "symlink" | "other" */
  readonly type: string;
  /** Present when stat: true */
  readonly size?: number;
  /** Present when stat: true. ISO 8601. */
  readonly mtime?: string;
}

interface LsToolResult {
  readonly entries: LsEntry[];
  readonly truncated: boolean;
  readonly total: number;
}
```

**Security:** Path resolution uses the same sandbox as `read`/`write` — no escaping the workspace root. Symlinks that resolve outside the workspace are listed but not followed for recursion.

### 3. `builtin-fs` — File operations

A multi-action file operations tool covering move, copy, delete, stat, and chmod.

```ts
interface FsToolParams {
  readonly action: "move" | "copy" | "delete" | "stat" | "chmod" | "rename";
  /** Source path (workspace-relative). Required for move, copy, delete, stat, chmod, rename. */
  readonly path: string;
  /** Destination path (workspace-relative). Required for move, copy, rename. */
  readonly dest?: string;
  /** File mode string (e.g. "755", "644"). Required for chmod. */
  readonly mode?: string;
  /** When true, delete directories recursively. Default: false. */
  readonly recursive?: boolean;
}
```

Each action returns a confirmation object:

```ts
// move, copy, rename
{ ok: true, action: "move", from: string, to: string }

// delete
{ ok: true, action: "delete", path: string, count: number }

// stat
{ ok: true, action: "stat", path: string, type: string, size: number,
  mtime: string, atime: string, mode: string, uid: number, gid: number }

// chmod
{ ok: true, action: "chmod", path: string, mode: string }
```

**Policy integration:** Each action maps to a policy action (`fs.move`, `fs.copy`, `fs.delete`, `fs.stat`, `fs.chmod`, `fs.rename`) with resource = path. Destructive actions (`delete`, `move`, `chmod`) can be gated independently from read-only ones (`stat`).

**Security:**
- All paths resolved within workspace sandbox. Symlink targets outside workspace are rejected for write operations.
- `delete` without `recursive: true` refuses to delete non-empty directories.
- `chmod` validates mode string format before applying.
- `rename` is a same-directory rename (no cross-directory move). Use `move` for that.

### 4. `builtin-kv` — Structured key-value store

A lightweight key-value store scoped to the workspace, backed by the state DB.

```ts
interface KvToolParams {
  readonly action: "get" | "set" | "delete" | "list";
  /** Key name. Required for get, set, delete. Max 256 chars. */
  readonly key?: string;
  /** Value to store. Required for set. Max 64KB when serialized. */
  readonly value?: unknown;
  /** Optional key prefix filter for list. */
  readonly prefix?: string;
  /** Max entries for list. Default: 100. */
  readonly limit?: number;
}
```

**Storage:** A new `kv_store` table in the state DB:

```sql
CREATE TABLE IF NOT EXISTS kv_store (
  workspace TEXT NOT NULL,
  key       TEXT NOT NULL,
  value     TEXT NOT NULL,  -- JSON-serialized
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (workspace, key)
);
```

Scoped by workspace path so multi-workspace deployments don't collide.

**Results:**

```ts
// get — returns null value when key doesn't exist
{ ok: true, key: string, value: unknown | null, exists: boolean }

// set
{ ok: true, key: string, written: true }

// delete
{ ok: true, key: string, deleted: boolean }

// list
{ ok: true, entries: { key: string, value: unknown, updatedAt: string }[], truncated: boolean }
```

**Retention:** KV entries are subject to a new optional retention rule `kvMaxEntries` (per workspace). When set, oldest entries beyond the cap are evicted on the retention sweep.

### 5. `builtin-timer` — Deferred actions

Allows agents to schedule future events that arrive as user-turn messages at a specified time.

```ts
interface TimerToolParams {
  readonly action: "set" | "cancel" | "list";
  /** Human-readable label. Required for set. */
  readonly label: string;
  /** When to fire. Required for set. ISO 8601 datetime or relative duration string (e.g. "2h", "30m", "90s", "1d"). */
  readonly at?: string;
  /** Message content delivered when the timer fires. Default: the label. */
  readonly message?: string;
  /** Timer ID. Required for cancel. */
  readonly id?: string;
}
```

**Storage:** A new `timers` table in the state DB:

```sql
CREATE TABLE IF NOT EXISTS timers (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  label       TEXT NOT NULL,
  fire_at     TEXT NOT NULL,  -- ISO 8601 UTC
  message     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  fired       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_timers_fire ON timers (fired, fire_at);
```

**Execution — in-process scheduler (not polling):**

Instead of a periodic poll job, timers use an in-process `setTimeout`-based scheduler with a min-heap priority queue. This gives millisecond-resolution delivery with zero wasted work.

```ts
interface TimerScheduler {
  /** Schedule a new timer. Inserts into DB and adds to the in-memory heap. */
  schedule(timer: TimerRecord): void;
  /** Cancel a timer by ID. Marks fired in DB and removes from heap. */
  cancel(id: string): boolean;
  /** Restore state on startup: fire any past-due timers, schedule the rest. */
  restore(db: Database.Database): Promise<void>;
  /** Tear down — clear all pending timeouts. */
  shutdown(): void;
}
```

How it works:

1. A min-heap orders pending timers by `fire_at` ascending.
2. A single `setTimeout` handle points at the soonest timer in the heap.
3. When the timeout fires: deliver the message to the target session, mark `fired = 1` in the DB, pop the heap, and schedule the next `setTimeout` for the new heap head.
4. When a new timer is inserted with a `fire_at` earlier than the current heap head, the existing `setTimeout` is cleared and rescheduled to the new earlier time.
5. When a timer is cancelled, it's removed from the heap. If it was the head, the `setTimeout` is rescheduled to the next entry.
6. On daemon startup, `restore()` queries all unfired timers from the DB. Any with `fire_at <= now` are fired immediately (in order). The rest are inserted into the heap and the first `setTimeout` is armed.

The DB remains the source of truth for crash recovery — the in-memory heap is a runtime optimization. If the daemon crashes and restarts, `restore()` picks up where it left off with no timers lost.

**Duration parsing:** Relative durations support `Xs` (seconds), `Xm` (minutes), `Xh` (hours), `Xd` (days). Parsed relative to `Date.now()` at set time. Minimum duration: 5 seconds. Maximum duration: 30 days.

**Results:**

```ts
// set
{ ok: true, id: string, label: string, fireAt: string }

// cancel
{ ok: true, id: string, cancelled: boolean }

// list
{ ok: true, timers: { id: string, label: string, fireAt: string, message: string }[] }
```

**Edge cases:**
- Timer fires while session is in a turn: queued as a pending user message.
- Timer fires for a terminated session: marked as fired, no delivery. Logged to audit.
- Daemon restart: `restore()` rescans on startup. Past-due timers fire immediately. No timers are lost.
- Duplicate labels: allowed. Each timer gets a unique ID.
- Minimum duration: timers shorter than 5 seconds are rejected with an error. Prevents tight-loop abuse and avoids unrealistic expectations about delivery precision.
- Many timers: only one `setTimeout` is active at a time (the soonest). 10,000 pending timers cost heap memory but zero OS timer resources beyond the single active one.

### Tool naming

Following existing convention, tools are registered as:
- `builtin-fetch`
- `builtin-ls`
- `builtin-fs`
- `builtin-kv`
- `builtin-timer`

### Shared infrastructure

All five tools use the existing `BuiltinToolRegistry` and `BuiltinToolContext` pattern. No changes to the registry interface are needed. Policy integration uses the existing `ToolLoopPolicy` audit/gate path — each tool calls `policy.check()` before executing.

## Implementation Phases

### Phase 1: `builtin-ls` — directory listing

The simplest tool with no external dependencies. Good warmup to validate the pattern.

**Files:**
- `packages/daemon/src/sessions/builtin-handlers/ls-handler.ts` — new: tool handler
- `packages/daemon/src/sessions/builtin-handlers/index.ts` — register
- `packages/mcp-integration/src/builtin-shoggoth-tools.ts` — tool schema definition

### Phase 2: `builtin-fs` — file operations

Builds on the same sandbox infrastructure as `read`/`write`/`ls`.

**Files:**
- `packages/daemon/src/sessions/builtin-handlers/fs-handler.ts` — new: multi-action handler
- `packages/daemon/src/sessions/builtin-handlers/index.ts` — register
- `packages/mcp-integration/src/builtin-shoggoth-tools.ts` — tool schema definition

### Phase 3: `builtin-fetch` — HTTP client

The most complex tool. Needs policy integration for URL gating and private IP blocking.

**Files:**
- `packages/daemon/src/sessions/builtin-handlers/fetch-handler.ts` — new: HTTP client handler
- `packages/daemon/src/sessions/builtin-handlers/index.ts` — register
- `packages/mcp-integration/src/builtin-shoggoth-tools.ts` — tool schema definition
- `packages/shared/src/network.ts` — new: private IP range detection utility

### Phase 4: `builtin-kv` — key-value store

Requires a DB migration for the `kv_store` table.

**Files:**
- `packages/daemon/src/sessions/builtin-handlers/kv-handler.ts` — new: KV handler
- `packages/daemon/src/sessions/builtin-handlers/index.ts` — register
- `packages/mcp-integration/src/builtin-shoggoth-tools.ts` — tool schema definition
- `packages/daemon/src/migrations/` — new migration: `kv_store` table
- `packages/daemon/src/retention/retention-jobs.ts` — optional `kvMaxEntries` eviction rule
- `packages/shared/src/config-schema.ts` — add `kvMaxEntries` to retention config

### Phase 5: `builtin-timer` — deferred actions

Requires a DB migration, an in-process timer scheduler, and session message injection.

**Files:**
- `packages/daemon/src/sessions/builtin-handlers/timer-handler.ts` — new: timer handler
- `packages/daemon/src/sessions/builtin-handlers/index.ts` — register
- `packages/mcp-integration/src/builtin-shoggoth-tools.ts` — tool schema definition
- `packages/daemon/src/migrations/` — new migration: `timers` table
- `packages/daemon/src/timers/timer-scheduler.ts` — new: min-heap scheduler with `setTimeout`, `TimerScheduler` interface
- `packages/daemon/src/timers/timer-heap.ts` — new: min-heap data structure for timer ordering
- `packages/daemon/src/index.ts` — instantiate scheduler, call `restore()` on startup, `shutdown()` on SIGTERM

## Testing Strategy

- **`builtin-ls`:** list workspace root, list subdirectory, recursive with depth cap, glob filtering, stat mode, hidden files, symlink handling, path outside workspace rejected, entry limit truncation.
- **`builtin-fs`:** move file, copy file, rename file, delete file, delete empty dir, delete non-empty dir without recursive (error), delete recursive, stat file, stat directory, chmod, path outside workspace rejected, dest outside workspace rejected, move overwrites existing.
- **`builtin-fetch`:** GET 200, GET 404, POST with JSON body (auto Content-Type), custom headers, response truncation at maxResponseBytes, timeout, private IP blocked, redirect not followed by default, redirect followed with cap, binary response as base64, policy denial returns error result.
- **`builtin-kv`:** set + get round-trip, get missing key returns null, delete existing, delete missing, list all, list with prefix, list with limit, value size cap enforced, key length cap enforced, workspace scoping (two workspaces don't collide), retention eviction.
- **`builtin-timer`:** set with ISO datetime, set with relative duration ("2h", "90s"), cancel, list, fire delivery (mock `setTimeout` via fake timers), fire into busy session (queued), fire into terminated session (no-op), `restore()` fires past-due timers on startup, `restore()` schedules future timers, heap reordering when earlier timer inserted, cancel of heap head reschedules, max duration enforced, per-session cap enforced, audit logging on fire, `shutdown()` clears pending timeout.
- **Timer heap:** insert ordering, extract-min, remove-by-id, peek, empty heap edge cases.

## Considerations

- **`builtin-fetch` and SSRF:** Private IP blocking is a baseline defense. For deployments behind a VPN or with internal APIs, the allowlist config is essential. Consider adding an explicit `allowInternalUrls` config flag that defaults to `false`.
- **`builtin-fetch` response size:** Returning 1MB of response body to the model consumes significant context. The default cap should be conservative. Consider a `jq`-style extraction parameter in a future iteration to let the model request only the fields it needs from JSON responses.
- **`builtin-kv` vs memory:** These serve different purposes. KV is for structured, machine-readable state. Memory is for unstructured, human-readable notes. The system prompt should make this distinction clear.
- **`builtin-timer` reliability:** Timers are best-effort. If the daemon is down when a timer is due, it fires on the next startup via `restore()`. Delivery is not guaranteed to be exact — Node.js `setTimeout` has inherent jitter (typically <10ms), which is negligible for this use case.
- **`builtin-timer` abuse:** An agent could create many timers. A per-session cap (default 50 active timers) prevents runaway scheduling. Expired/fired timers are cleaned up by retention.
- **`builtin-timer` memory:** The min-heap holds one entry per unfired timer. Each entry is ~200 bytes. 10,000 timers ≈ 2MB — negligible. Only one OS-level `setTimeout` is active at any time regardless of heap size.
- **`builtin-fs` and `rename` vs `move`:** `rename` is intentionally limited to same-directory renames to match the semantic of "change the name." Cross-directory moves use `move`. This avoids confusion about whether `rename` preserves the directory.
- **Phase ordering:** Phases 1–3 are independent and could run in parallel. Phase 4 and 5 each need a migration and are best done sequentially to avoid migration ordering conflicts.

## Migration

- **Phase 4** adds a `kv_store` table via a new migration file. No existing data affected.
- **Phase 5** adds a `timers` table via a new migration file. No existing data affected.
- Phases 1–3 require no migrations.
- No state wipe needed for any phase.
