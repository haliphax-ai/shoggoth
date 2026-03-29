# MCP transport (Shoggoth daemon)

## What is implemented

- **`@shoggoth/mcp-integration`**: merges catalogs (`aggregateMcpCatalogs`), stable `source.tool` names, routing (`routeMcpToolInvocation`), and `tools/list`-style payloads with JSON Schema (`toMcpToolsListPayload`).
- **JSON-RPC MCP client** (no extra npm dependency): newline-delimited JSON-RPC 2.0 over **stdio** (child process) or **TCP** (same framing). Implements MCP **`initialize`** + **`notifications/initialized`**, **`tools/list`** (with `nextCursor` pagination), and **`tools/call`**. Entry points: `openMcpStdioClient`, `openMcpTcpClient`, `mcpFetchToolsList`, `mcpInvokeTool` (`packages/mcp-integration/src/mcp-jsonrpc-transport.ts`).
- **Streamable HTTP** (MCP spec 2025-11-25): each client message is an **HTTP POST** to a single MCP endpoint with `Accept: application/json, text/event-stream`, `MCP-Protocol-Version` (updated from `initialize` result), and optional **`MCP-Session-Id`** after the server sets it on the initialize response. The server may answer with **`application/json`** (single JSON-RPC response) or **`text/event-stream`** (SSE `data:` lines carrying JSON-RPC objects until the response for that request id). **`notifications/initialized`** expects **202** (or lenient **200**). Session teardown: **HTTP DELETE** with `MCP-Session-Id` when the server assigned one. Entry points: `openMcpStreamableHttpClient`, `connectMcpStreamableHttpSession` (`packages/mcp-integration/src/mcp-streamable-http-transport.ts`). Uses **`fetch` + Web Streams** only.
- **Standing GET + SSE**: after POST traffic, the client opens a long-lived **GET** on the same URL (unless the server returns **404/405**, in which case the client uses POST-only mode). JSON-RPC replies for **202 Accepted** POSTs are expected on that GET stream. Optional **`onServerMessage`** on connect options delivers inbound **notifications** (no JSON-RPC `id`), **orphan** responses (an `id` not in the client’s pending map), and **`notifications/cancelled`** after the matching pending request is rejected.
- **Cancellation** ([MCP cancellation](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation)): inbound **`notifications/cancelled`** with `params.requestId` (optional `reason`) rejects the matching in-flight `request()` with **`MCP request cancelled`**. **`cancelRequest(rpcId)`** on `McpStreamableHttpSession` sends the same notification to the server (client-initiated cancel). **`close()`** clears the pending map then rejects remaining waiters (no double-settle races with SSE delivery).
- **SSE stream resumption**: SSE events may include an **`id:`** field. While reading an SSE response for a JSON-RPC request, the client records the last seen event id. If the stream ends before a matching JSON-RPC response or the read throws (e.g. network reset), the client issues **one automatic retry** of the same POST with the **`Last-Event-ID`** request header set to that id (same header browsers use for `EventSource`). No further retries (avoids loops). If no `id:` was received before the failure, behavior is unchanged (no resume header). **`getLastSseEventId()`** on `McpStreamableHttpSession` returns the last non-empty `id:` seen while parsing SSE for that HTTP session (for debugging or advanced use). **Limitations**: only the JSON-RPC POST path retries (not the standing GET loop); servers that omit `id:` cannot be resumed by this client on the POST SSE path.
- **SSE JSON batch**: if one SSE `data:` line parses to a **JSON array**, each element is dispatched as a separate JSON-RPC value (minimal interop). Servers that need richer batching should be validated against your stack.
- **`@shoggoth/daemon`**: `buildAggregatedMcpCatalog`, `mcpToolsForToolLoop`, and `createMcpRoutingToolExecutor` connect that catalog to `runToolLoop` (`packages/daemon/src/mcp/tool-loop-mcp.ts`). Built-in tools use source id `builtin` (`builtin.read`, `builtin.write`, `builtin.exec`, `builtin.memory.search`, `builtin.memory.ingest`). Policy and HITL see the same namespaced names; `classifyToolRisk` matches the segment after the first dot (e.g. `memory.search`) to configured tiers when present.
- **Config-driven external MCP**: optional top-level **`mcp`** in layered config (`@shoggoth/shared` schema). **`mcp.servers`**: each entry has a dot-free **`id`** (MCP source id) and **`transport`**:
  - **`stdio`**: `command`, optional `args`, `cwd`, `env`
  - **`tcp`**: `host`, `port`
  - **`http`**: **`url`** (MCP endpoint, POST+GET), optional **`headers`** (string values, e.g. auth)
- **`mcp.poolScope`** (default **`global`**): default for servers that omit **`poolScope`** or set **`poolScope: "inherit"`**. **`global`** — those servers’ MCP connections are opened when the Discord platform (`startDiscordPlatform` in `packages/daemon/src/platforms/discord.ts`) starts. **`per_session`** — lazy `connectShoggothMcpServers` for those servers on the **first inbound Discord turn** per Shoggoth `sessionId`, reused for later turns; **all pools are closed on `stop()`** when the platform shuts down. There is no idle timeout; long-lived sessions keep MCP open until stop (or process exit).
- **Per-server `poolScope`** (optional, default **`inherit`** via omission): **`inherit`** — use top-level `mcp.poolScope`. **`global`** — this entry’s connections are opened once at Discord platform startup (shared across Discord sessions). **`per_session`** — this entry’s connections are opened lazily per Shoggoth `sessionId`. **Mixed configs** connect global-scoped servers at startup and merge their tool catalogs with each session’s per-session servers (global sources first in `aggregateMcpCatalogs`; duplicate `sourceId.tool` names across the combined set still throw). **`tools/call`** routes to the correct pool by server **`id`** (`sourceId`).

## Operational notes

- **Inbound server messages (debug)**: When **`SHOGGOTH_MCP_LOG_SERVER_MESSAGES=1`**, the Discord platform enables structured **`debug`** logs (`component: mcp-sse`, message `mcp.server_message`) for each streamable HTTP **`onServerMessage`** (notifications, orphan responses, post-cancelled delivery). Stdio/TCP pools are unchanged. Tests can pass **`onMcpServerMessage`** directly via the optional second argument to **`connectShoggothMcpServers(servers, options?)`**.
- **Operator cancel (streamable HTTP)**: **`cancelRequest(rpcId)`** is exposed per configured server **`id`** (`sourceId`) through the MCP pool and a small process registry keyed by Shoggoth session:
  - **Control op** **`mcp_http_cancel_request`** (operator-only). Payload: **`session_id`** (string), **`source_id`** (string), **`request_id`** (number, JSON-RPC numeric id in flight on that HTTP session). Response: **`{ cancelled: true }`** if a streamable session handled it, else **`{ cancelled: false }`** (unknown session key, non-HTTP source id, or pool already closed).
  - **CLI**: **`shoggoth mcp cancel <sessionId> <sourceId> <requestId>`** — same fields as the control payload. Prints JSON from the control socket.
- **`session_id` semantics for cancel**:
  - **`__global__`** — the Discord platform’s **global** MCP pool (servers with effective **`global`** pool scope, connected at startup).
  - Any other string — the Shoggoth **`sessionId`** for that Discord route (same id as SQLite session / transcript), targeting the **per-session** pool for that session when **`per_session`** (or mixed) servers are in use. If only global MCP is configured, use **`__global__`**.
- **Tests**: `@shoggoth/mcp-integration` exercises streamable HTTP against a local `node:http` mock (JSON and SSE responses). `@shoggoth/daemon` runs `connectShoggothMcpServers` through `runToolLoop` for stdio fixtures and streamable HTTP; `partitionMcpServersByEffectiveScope` is covered in `mcp-server-pool.test.ts`; `startDiscordPlatform` in `test/platforms/discord.test.ts` covers **`mcp.poolScope`**, **per-server `poolScope`**, and **mixed** wiring via optional `deps.connectShoggothMcpServers` injection (unit tests only).
- **Lifecycle**: MCP stdio subprocesses, TCP sockets, and HTTP sessions (including optional DELETE) are closed when the Discord platform **`stop()`** runs (daemon shutdown drain). Per-session scope additionally closes every session-scoped pool on stop.
- **Failures**: If connecting or handshaking throws, the error is logged (`session.mcp_pool.connect_failed`). **Global** slice failure: no global MCP tools for the run (built-ins only if there is no working global pool). **Per-session** slice failure: that session’s merged context drops the per-session tools but **keeps global tools** when mixed mode is configured; the failed attempt is cached for that `sessionId`.
- **`@modelcontextprotocol/sdk`**: not bundled; the in-tree client is intentionally minimal (MIT-compatible JSON-RPC). You can still run MCP servers that speak the transports above.

### Example: Streamable HTTP with auth header

```json
{
  "mcp": {
    "poolScope": "per_session",
    "servers": [
      {
        "id": "remote_tools",
        "transport": "http",
        "url": "https://mcp.example.com/v1/mcp",
        "headers": {
          "Authorization": "Bearer ${REMOTE_MCP_TOKEN}"
        }
      }
    ]
  }
}
```

### Example: Global indexer + per-session sandbox

Default top-level **`global`**; one stdio server opts into **`per_session`** so each Shoggoth session gets its own MCP connection for that entry.

```json
{
  "mcp": {
    "poolScope": "global",
    "servers": [
      {
        "id": "indexer",
        "transport": "stdio",
        "command": "mcp-indexer",
        "args": []
      },
      {
        "id": "sandbox",
        "transport": "stdio",
        "command": "mcp-sandbox",
        "args": [],
        "poolScope": "per_session"
      }
    ]
  }
}
```

### Example: Mixed pools (one shared gateway + per-session tools)

Top-level `poolScope` applies only to entries with **`poolScope: "inherit"`** (or omitted). Explicit **`global`** / **`per_session`** overrides per entry.

```json
{
  "mcp": {
    "poolScope": "per_session",
    "servers": [
      {
        "id": "shared_gateway",
        "transport": "http",
        "url": "https://mcp.example.com/v1/mcp",
        "poolScope": "global"
      },
      {
        "id": "session_tools",
        "transport": "stdio",
        "command": "my-mcp-server",
        "poolScope": "inherit"
      }
    ]
  }
}
```

Note: Shoggoth does not expand `${...}` in headers; put literal header values or use env injection in your deployment layer.

## What is not implemented yet

- **Deprecated HTTP+SSE (2024-11-05)** transport shape (distinct from 2025-11-25 streamable HTTP); this client targets **2025-11-25** streamable HTTP only.
- **Standing GET SSE resumption**: automatic **`Last-Event-ID`** retry is implemented for **POST** response SSE, not for the long-lived GET stream (GET loop reconnects without replay beyond what the server sends after reconnect).
- **Malformed SSE `data:`** payloads: still ignored by default (no callback); use `iterateSseDataJson` yourself if you need raw handling.
- **Idle timeout / refcount** for per-session pools (only full stop cleanup).

If you add external tool descriptors only in code without a live server, `createMcpRoutingToolExecutor` still returns `mcp_external_transport_unavailable` when no `external` callback is supplied.
