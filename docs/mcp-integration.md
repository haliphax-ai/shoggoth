# MCP Integration — Reference

Package: `@shoggoth/mcp-integration` (`shoggoth/packages/mcp-integration`)

This package implements Shoggoth's integration with the **Model Context Protocol (MCP)**. It is consumed by the [daemon](daemon.md) during tool resolution in [agent turns](daemon.md#agent-turns). It provides transport layers for connecting to MCP servers, tool catalog aggregation, invocation routing, and bridges for exposing Shoggoth's own built-in tools as MCP-compatible descriptors.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────┐
│                   Shoggoth Daemon                     │
│                                                       │
│  ┌─────────────────┐   ┌──────────────────────────┐  │
│  │ Builtin Tools    │   │ External MCP Servers      │  │
│  │ (read, write,    │   │ (stdio / TCP / HTTP+SSE)  │  │
│  │  exec, fetch…)   │   │                            │  │
│  └────────┬─────────┘   └────────────┬───────────────┘  │
│           │                          │                   │
│           ▼                          ▼                   │
│  ┌─────────────────────────────────────────────────┐    │
│  │          Catalog Aggregation Layer               │    │
│  │  aggregateMcpCatalogs() → namespaced tool list   │    │
│  │  routeMcpToolInvocation() → dispatch             │    │
│  └──────────────────────┬──────────────────────────┘    │
│                         │                                │
│                         ▼                                │
│  ┌─────────────────────────────────────────────────┐    │
│  │  Advertise (toMcpToolsListPayload)               │    │
│  │  → MCP tools/list compatible payload for models  │    │
│  └─────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────┘
```

The package is organized into these layers:

1. **Transports** — Low-level connections to MCP servers (stdio, TCP, Streamable HTTP/SSE).
2. **Tool Discovery** — Fetching `tools/list` from servers, converting entries to descriptors.
3. **Aggregation & Routing** — Merging multiple tool catalogs under namespaced names, dispatching invocations.
4. **Advertising** — Converting aggregated catalogs into MCP-compatible `tools/list` payloads.
5. **Built-in Tools** — Shoggoth's own tools (read, write, exec, etc.) expressed as MCP descriptors.
6. **ACP Bridge** — Mapping external agent workspaces to Shoggoth sessions.
7. **Message Tool Descriptor** — Dynamic schema generation for the platform-aware `message` tool.

---

## Transports

### Stdio (JSON-RPC over newline-delimited JSON)

The primary transport for local MCP servers. Spawns a child process and communicates over stdin/stdout using newline-delimited JSON-RPC 2.0.

#### Quick Start

```typescript
import { openMcpStdioClient } from "@shoggoth/mcp-integration";

// Full handshake: spawn → initialize → notifications/initialized
const session = await openMcpStdioClient({
  command: "node",
  args: ["my-mcp-server.js"],
  cwd: "/path/to/server",
  env: process.env,
});

// Now ready for tools/list, tools/call, etc.
```

#### Options (`McpStdioConnectOptions`)

| Field            | Type                | Description                                                  |
| ---------------- | ------------------- | ------------------------------------------------------------ |
| `command`        | `string`            | Executable to spawn.                                         |
| `args`           | `string[]`          | Command-line arguments.                                      |
| `cwd`            | `string`            | Working directory for the subprocess.                        |
| `env`            | `NodeJS.ProcessEnv` | Environment variables for the subprocess.                    |
| `processManager` | `ProcessManager`    | Optional `@shoggoth/procman` instance for managed lifecycle. |

#### Process Management

When a `processManager` is provided, the MCP server process is spawned via `@shoggoth/procman` instead of raw `child_process.spawn`. This gives:

- Automatic restart on failure (`on-failure` mode, up to 5 retries).
- Graceful shutdown with `SIGTERM` and a 5-second grace period.
- Managed process ID tracking under the `mcp-server` owner kind.

Without `processManager`, the transport falls back to direct spawn with manual SIGTERM → SIGKILL escalation on close.

#### Low-Level API

```typescript
import {
  connectMcpStdioSession, // spawn + wire, no handshake
  createMcpJsonRpcSession, // raw streams → session
  mcpInitializeSession, // initialize + notifications/initialized
} from "@shoggoth/mcp-integration";

// Step-by-step if you need control:
const session = await connectMcpStdioSession(opts);
await mcpInitializeSession(session, { protocolVersion: "2024-11-05" });
```

### TCP (JSON-RPC over newline-delimited JSON)

Same wire format as stdio, but over a TCP socket. Useful for remote or containerized MCP servers.

```typescript
import { openMcpTcpClient } from "@shoggoth/mcp-integration";

const session = await openMcpTcpClient({
  host: "127.0.0.1",
  port: 9100,
});
```

#### Options (`McpTcpConnectOptions`)

| Field  | Type     | Description             |
| ------ | -------- | ----------------------- |
| `host` | `string` | TCP host to connect to. |
| `port` | `number` | TCP port.               |

### Streamable HTTP (MCP 2025-11-25)

Implements the MCP Streamable HTTP transport: JSON-RPC messages are sent as HTTP POST requests, and responses may arrive as `application/json`, `text/event-stream` (SSE) on the POST response body, or via a standing `GET` SSE stream.

```typescript
import { openMcpStreamableHttpClient } from "@shoggoth/mcp-integration";

const session = await openMcpStreamableHttpClient({
  url: "https://mcp-server.example.com/mcp",
  headers: { Authorization: "Bearer token" },
});
```

#### Options (`McpStreamableHttpConnectOptions`)

| Field                             | Type                     | Description                                                                      |
| --------------------------------- | ------------------------ | -------------------------------------------------------------------------------- |
| `url`                             | `string`                 | MCP server HTTP endpoint URL.                                                    |
| `headers`                         | `Record<string, string>` | Extra request headers (e.g., auth).                                              |
| `protocolVersion`                 | `string`                 | Protocol version for `initialize` (default: `2025-11-25`).                       |
| `initialMcpProtocolVersionHeader` | `string`                 | First `MCP-Protocol-Version` header before negotiation (default: `2025-11-25`).  |
| `onServerMessage`                 | `(msg) => void`          | Callback for inbound notifications, orphan responses, and cancellation events.   |
| `onParseError`                    | `(info) => void`         | Callback for SSE events whose `data:` payload is not valid JSON (event skipped). |

#### Key Behaviors

- **Session ID tracking**: Automatically captures and sends `MCP-Session-Id` headers.
- **Standing GET SSE**: Opens a long-lived `GET` request for server-push messages. Automatically disabled if the server returns 405/404 (POST-only mode).
- **SSE resumption**: Tracks `id:` fields from SSE events and sends `Last-Event-ID` on reconnect for resumable streams. POST-body SSE also supports one retry with `Last-Event-ID`.
- **Cancellation**: Supports MCP 2025-11-25 cancellation via `notifications/cancelled` with `params.requestId`. Both client-initiated (`cancelRequest(rpcId)`) and server-initiated cancellation are handled.
- **Batch interop**: If a single SSE `data:` line parses to a JSON array, each element is dispatched individually.
- **Session teardown**: Sends HTTP `DELETE` to the endpoint on close if a session ID was established.

#### Extended Session Interface (`McpStreamableHttpSession`)

Extends `McpJsonRpcSession` with:

| Method                 | Description                                                                      |
| ---------------------- | -------------------------------------------------------------------------------- |
| `getLastSseEventId()`  | Returns the last SSE event ID seen (for resumption introspection).               |
| `cancelRequest(rpcId)` | Sends `notifications/cancelled` to the server for the given JSON-RPC request ID. |

#### SSE Parsing Utility

```typescript
import { iterateSseDataJson } from "@shoggoth/mcp-integration";

// Parse a text/event-stream body into typed JSON events
for await (const event of iterateSseDataJson(response.body)) {
  console.log(event.eventId, event.json);
}
```

Events whose `data:` payload is not valid JSON are skipped. Pass `options.onParseError` to be
notified of each skipped event so server-side bugs are not silently masked:

```typescript
for await (const event of iterateSseDataJson(response.body, {
  onParseError: ({ eventId, data, error }) =>
    console.warn("malformed SSE event", eventId, data, error),
})) {
  console.log(event.eventId, event.json);
}
```

---

## Session Interface (`McpJsonRpcSession`)

All transports produce a session with this interface:

```typescript
interface McpJsonRpcSession {
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): void | Promise<void>;
  close(): Promise<void>;
}
```

| Method    | Description                                                                                                           |
| --------- | --------------------------------------------------------------------------------------------------------------------- |
| `request` | Send a JSON-RPC request and await the response. Concurrent requests are supported (each gets a unique numeric `id`).  |
| `notify`  | Send a JSON-RPC notification (no `id`, no response expected). Returns `void` for stdio/TCP, `Promise<void>` for HTTP. |
| `close`   | Tear down the session. Rejects all pending requests. Kills/disconnects the underlying transport.                      |

---

## Tool Discovery

After establishing a session, discover available tools:

```typescript
import { mcpFetchToolsList, mcpToolListEntryToDescriptor } from "@shoggoth/mcp-integration";

// Fetches all pages (handles cursor-based pagination)
const tools = await mcpFetchToolsList(session);

// Convert to Shoggoth descriptors
const descriptors = tools.map(mcpToolListEntryToDescriptor);
```

### `mcpFetchToolsList(session, options?)`

Calls `tools/list` with automatic cursor-based pagination. Returns an array of `McpToolListEntry`:

```typescript
interface McpToolListEntry {
  name: string;
  description?: string;
  inputSchema?: unknown;
}
```

Entries that do not match the expected shape (an object with a string `name`) are skipped. Pass
`options.onSkippedToolEntry` to be notified of each skipped entry:

```typescript
const tools = await mcpFetchToolsList(session, {
  onSkippedToolEntry: (entry) => console.warn("skipped malformed tool entry", entry),
});
```

### `mcpToolListEntryToDescriptor(entry)`

Converts an MCP tool list entry into a `McpToolDescriptor` with a typed `JsonSchemaLike` input schema. Falls back to `{ type: "object", properties: {} }` if no schema is provided.

### `mcpToolsToSourceCatalog(sourceId, tools)`

Convenience: converts an array of `McpToolListEntry` into an `McpSourceCatalog` ready for aggregation.

```typescript
import { mcpToolsToSourceCatalog } from "@shoggoth/mcp-integration";

const catalog = mcpToolsToSourceCatalog("my-server", tools);
```

---

## Tool Invocation

```typescript
import { mcpInvokeTool } from "@shoggoth/mcp-integration";

const result = await mcpInvokeTool(session, "toolName", { arg1: "value" });
// result is the raw MCP tools/call response (content, isError, etc.)
```

---

## Catalog Aggregation & Routing

When multiple MCP sources (built-in tools, external servers) are active, their tool catalogs must be merged into a single namespace for the model.

### Aggregation

```typescript
import { aggregateMcpCatalogs } from "@shoggoth/mcp-integration";

const result = aggregateMcpCatalogs([
  builtinCatalog, // sourceId: "builtin"
  externalCatalog, // sourceId: "my-server"
]);
// result.tools → AggregatedTool[] with namespacedName like "builtin-read", "my-server-search"
```

#### Namespacing

Tools are namespaced as `{sourceId}-{toolName}`. For example:

- Source `builtin`, tool `read` → `builtin-read`
- Source `github`, tool `search` → `github-search`

Source IDs must not contain dots. Duplicate namespaced names throw an error to prevent ambiguous routing.

#### Types

```typescript
interface McpSourceCatalog {
  sourceId: string;
  tools: McpToolDescriptor[];
}

interface AggregatedTool extends McpToolDescriptor {
  namespacedName: string; // e.g. "builtin-read"
  sourceId: string; // e.g. "builtin"
  originalName: string; // e.g. "read"
}

interface AggregateMcpCatalogResult {
  tools: AggregatedTool[];
}
```

### Routing

```typescript
import { routeMcpToolInvocation } from "@shoggoth/mcp-integration";

const result = routeMcpToolInvocation(aggregated, "my-server-search");
if ("tool" in result) {
  // result.tool.sourceId → "my-server"
  // result.tool.originalName → "search"
} else {
  // result.error → "unknown MCP tool: ..."
}
```

---

## Advertising

Convert an aggregated catalog into an MCP-compatible `tools/list` payload for model consumption:

```typescript
import { toMcpToolsListPayload } from "@shoggoth/mcp-integration";

const payload = toMcpToolsListPayload(aggregated);
// payload.tools → [{ name: "builtin-read", description: "...", inputSchema: {...} }, ...]
```

---

## Built-in Shoggoth Tools

`builtinShoggothToolsCatalog()` returns an `McpSourceCatalog` containing all of Shoggoth's native tools expressed as MCP tool descriptors. The default source ID is `"builtin"`.

```typescript
import { builtinShoggothToolsCatalog, BUILTIN_SOURCE_ID } from "@shoggoth/mcp-integration";

const catalog = builtinShoggothToolsCatalog();
// catalog.sourceId === "builtin"
// catalog.tools includes: read, write, exec, memory-search, memory-ingest,
//   subagent, session-list, session-send, session-query, poll, skills,
//   config-request, config-show, show, fs, ls, fetch, kv, timer,
//   discover, search-replace, cd, workflow
```

### Included Tools

| Tool             | Description                                                                     |
| ---------------- | ------------------------------------------------------------------------------- |
| `read`           | Read a file under the session workspace.                                        |
| `write`          | Write a file under the session workspace.                                       |
| `exec`           | Execute a command (supports background, timeout, stdin, env overrides).         |
| `memory-search`  | Full-text search over ingested markdown memory (BM25 + optional embeddings).    |
| `memory-ingest`  | Scan configured paths for `*.md` and upsert into the state DB.                  |
| `subagent`       | Spawn, inspect, steer, abort, kill, wait, and retrieve results from subagents.  |
| `session-list`   | List sessions with optional status/agent filters.                               |
| `session-send`   | Deliver a message to another session (cross-agent or same-agent).               |
| `session-query`  | Read-only query of session transcript messages.                                 |
| `poll`           | Check status and output of background processes.                                |
| `skills`         | List, resolve, or read skill files from configured scan roots.                  |
| `config-request` | Request a dynamic configuration change for a config key.                        |
| `config-show`    | Show current daemon configuration (redacted).                                   |
| `show`           | Display images or visual content to the user.                                   |
| `fs`             | File operations: move, copy, delete, stat, chmod, mkdir.                        |
| `ls`             | List directory contents with glob, recursion, and metadata support.             |
| `fetch`          | Make HTTP requests (private IPs blocked by default).                            |
| `kv`             | Workspace-scoped key-value store (state DB backed).                             |
| `timer`          | Schedule, cancel, or list deferred timer actions.                               |
| `discover`       | Enable/disable tools dynamically for the session.                               |
| `search-replace` | Ripgrep search and regex replace across files.                                  |
| `cd`             | Change the session working directory.                                           |
| `workflow`       | Orchestrate parallel/sequential subagent workflows (from `@shoggoth/workflow`). |

---

## Message Tool Descriptor

The `message` tool schema is generated dynamically based on the active messaging platform's capabilities.

```typescript
import { buildMessageToolDescriptor } from "@shoggoth/mcp-integration";

const descriptor = buildMessageToolDescriptor({
  attachments: true,
  messageEdit: true,
  messageDelete: true,
  threadCreate: true,
  threadDelete: true,
  replies: true,
  messageGet: true,
  react: true,
  reactions: true,
  search: true,
  attachmentDownload: true,
});
```

### Platform Capability Flags (`MessageToolPlatformSlice`)

| Flag                 | Effect on Schema                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------- |
| `attachments`        | Adds `attachments` array property (base64 file uploads).                                                   |
| `messageEdit`        | Adds `edit` to the `action` enum.                                                                          |
| `messageDelete`      | Adds `delete` to the `action` enum.                                                                        |
| `threadCreate`       | Adds `create_thread` action and `auto_archive_duration_minutes`.                                           |
| `threadDelete`       | Adds `delete_thread` action.                                                                               |
| `replies`            | Adds `reply_to_message_id` property.                                                                       |
| `messageGet`         | Adds `get` action with `channel_id`, `limit`, `anchor_message_id`, `list_direction`.                       |
| `react`              | Adds `react` and `choice` actions with `emoji`, `remove`, `choices` properties.                            |
| `reactions`          | Adds `reactions` action with `emoji` filter.                                                               |
| `search`             | Adds `search` action with `query`, `author_id`, `author_ids`, `before`, `after`, `from_me`, `channel_ids`. |
| `attachmentDownload` | Adds `attachment-download` action with `filename`, `index`, `path`.                                        |

The schema is intentionally flat (no `oneOf`/`anyOf`/`allOf` at the top level) for compatibility with Anthropic Messages API and similar gateways. Per-action field requirements are enforced at execution time, not in the schema.

---

## ACP Bridge

Maps external agent workspaces (ACP / acpx) to Shoggoth sessions and principals. The daemon spawns `acpx` processes with specific environment variables so the agent can authenticate to the Shoggoth control plane.

### Environment Variables

| Constant                           | Env Var                        | Description                                                            |
| ---------------------------------- | ------------------------------ | ---------------------------------------------------------------------- |
| `SHOGGOTH_CONTROL_SOCKET_ENV`      | `SHOGGOTH_CONTROL_SOCKET`      | Unix socket path for the Shoggoth control plane (JSONL wire protocol). |
| `SHOGGOTH_SESSION_ID_ENV`          | `SHOGGOTH_SESSION_ID`          | Bound Shoggoth session ID for the acpx workspace.                      |
| `SHOGGOTH_ACPX_WORKSPACE_ROOT_ENV` | `SHOGGOTH_ACPX_WORKSPACE_ROOT` | ACP workspace root path (hint for agent tooling).                      |

### Binding Management

```typescript
import {
  createAcpxBinding,
  findBindingForAcpxWorkspace,
  type AcpxWorkspaceBinding,
} from "@shoggoth/mcp-integration";

// Create a binding record
const binding = createAcpxBinding({
  acpWorkspaceRoot: "/workspaces/agent-1",
  shoggothSessionId: "agent:main:discord:...",
  agentPrincipalId: "agent-1",
});

// Look up a binding by workspace root
const found = findBindingForAcpxWorkspace(bindings, "/workspaces/agent-1");
```

---

## JSON Schema Types

The package uses a lightweight `JsonSchemaLike` interface for tool input schemas, intentionally dependency-free:

```typescript
interface JsonSchemaLike {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchemaLike>;
  items?: JsonSchemaLike;
  required?: string[];
  additionalProperties?: boolean;
  enum?: unknown[];
  oneOf?: JsonSchemaLike[];
  minimum?: number;
  maximum?: number;
}
```

---

## MCP Tool Descriptor

The base descriptor type used throughout the package:

```typescript
interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema: JsonSchemaLike;
}
```

---

## Lifecycle Summary

A typical MCP server integration follows this flow:

1. **Connect** — Use `openMcpStdioClient`, `openMcpTcpClient`, or `openMcpStreamableHttpClient` to establish a session (spawn/connect + `initialize` + `notifications/initialized`).
2. **Discover** — Call `mcpFetchToolsList(session)` to get available tools (handles pagination).
3. **Catalog** — Convert to `McpSourceCatalog` via `mcpToolsToSourceCatalog(sourceId, tools)`.
4. **Aggregate** — Merge with built-in tools via `aggregateMcpCatalogs([builtinCatalog, ...externalCatalogs])`.
5. **Advertise** — Convert to model-facing payload via `toMcpToolsListPayload(aggregated)`.
6. **Route & Invoke** — On tool call from the model, use `routeMcpToolInvocation` to find the target, then `mcpInvokeTool` on the appropriate session.
7. **Close** — Call `session.close()` to tear down transport and reject pending requests.

---

## Dependencies

| Package              | Purpose                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------- |
| `@shoggoth/procman`  | Optional managed process lifecycle for stdio MCP servers.                                                  |
| `@shoggoth/workflow` | Provides the `workflow` tool descriptor via `buildWorkflowToolDescriptor()` (see [Workflow](workflow.md)). |

---

## See Also

- [Daemon](daemon.md) — consumes this package for tool resolution during agent turns
- [Workflow](workflow.md) — workflow tool descriptor and task execution
- [Shared](shared.md) — `ShoggothMcpConfig` schema for server definitions
- [Skills & Plugins](skills-plugins.md) — skills are a separate discovery mechanism alongside MCP tools
