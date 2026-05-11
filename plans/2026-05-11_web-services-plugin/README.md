---
date: 2026-05-11
completed: never
---

# Web Services Plugin

## Summary

A first-class subsystem for declaring, managing, discovering, and communicating with HTTP/WebSocket services within Shoggoth. Enables agents to expose and consume web-based interfaces (Canvas, dashboards, APIs) through a unified lifecycle managed by procman.

## Motivation

Shoggoth currently has no concept of web services. Procman manages process lifecycles, but there's no layer above it that understands "this process serves HTTP on port X" or "agents should be able to call this service." As we port Canvas Web and anticipate future integrations (dashboards, webhook receivers, agent-facing APIs), we need a standard pattern for:

1. Declaring a web service and its contract (port, routes, protocol)
2. Letting procman manage its lifecycle with service-aware health checks
3. Allowing agents to discover and interact with services via tools
4. Optionally exposing services through a shared HTTP gateway with auth
5. Providing a communication bridge between agents and services (bidirectional)

Without this, each web integration becomes a bespoke wiring job. A plugin spec gives us a repeatable pattern and a clear extension point.

## Design

### Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│ Shoggoth Daemon                                         │
│                                                         │
│  ┌──────────┐    ┌──────────────────┐    ┌──────────┐  │
│  │ procman  │◄───│ Service Registry │───►│ Gateway  │  │
│  │          │    │                  │    │ (HTTP)   │  │
│  │ start/   │    │ - endpoints      │    │          │  │
│  │ stop/    │    │ - health state   │    │ /svc/:id │  │
│  │ restart  │    │ - capabilities   │    │ → proxy  │  │
│  └──────────┘    └──────────────────┘    └──────────┘  │
│       │                   ▲                     ▲       │
│       ▼                   │                     │       │
│  ┌──────────┐    ┌──────────────────┐           │       │
│  │ Service  │───►│ Plugin Tools     │           │       │
│  │ Process  │    │ (service-provided│           │       │
│  │ (Canvas) │    │  e.g. canvas.*)  │           │       │
│  │          │◄───│                  │           │       │
│  └──────────┘    └──────────────────┘           │       │
│                                                 │       │
└─────────────────────────────────────────────────│───────┘
                                                  │
                                            External clients
                                            (browsers, etc.)
```

### Key Components

**1. Service Declaration (config-driven)**

Extends the existing `processes[]` config with an optional `service` block. When present, the process is treated as a web service with additional lifecycle semantics.

```jsonc
{
  "processes": [
    {
      "id": "canvas-web",
      "label": "Canvas Web",
      "startPolicy": "boot",
      "command": "node",
      "args": ["dist/server/index.js"],
      "cwd": "/opt/shoggoth-canvas",
      "env": { "PORT": "3100" },
      "restartMode": "on-failure",
      "health": { "kind": "http", "target": "http://localhost:3100/health" },
      "service": {
        "port": 3100,
        "protocol": "http",
        "basePath": "/",
        "capabilities": ["canvas", "a2ui"],
        "expose": "gateway",
      },
    },
  ],
}
```

**2. Service Registry (runtime)**

A singleton that tracks healthy services and their metadata. Populated by procman lifecycle events (process started + health check passed → registered; process stopped → deregistered). Provides lookup by ID and by capability.

**3. HTTP Gateway (optional, daemon-managed)**

A lightweight reverse proxy that routes external requests to managed services. Runs as a procman-managed process itself (or an in-process HTTP listener). Provides:

- Path-based routing: `GET /svc/canvas-web/...` → `http://localhost:3100/...`
- Auth enforcement: validates Shoggoth-issued tokens before proxying
- CORS and rate limiting at the edge

The gateway is optional — services can also bind directly to host ports for development or single-service deployments.

**4. Plugin Tool Registration**

Services provide their own tools rather than going through a generic invoke layer. The service plugin spec defines a hook for services to register tools with the daemon at startup:

- Service declares its tools in its manifest (`GET /manifest` → `tools[]`)
- On service registration (healthy), the daemon registers those tools into the builtin tool registry scoped to the service
- On service deregistration (stopped/failed), tools are removed
- Tools are thin proxies: the daemon handles auth token minting and HTTP dispatch; the service defines the tool schema and handles the request

This means Canvas provides `canvas.show`, `canvas.push`, `canvas.eval` etc. as first-class agent tools — not generic HTTP calls wrapped in a `service.invoke` envelope.

**5. Auth: Per-Service Key Pairs with Operator Approval**

New services must be registered and approved by the operator via the CLI before they can communicate with the daemon. During registration, a unique key pair is generated for that service.

Registration flow:

1. Operator runs `shoggoth service register <id>` (or the service is declared in config with `approved: false`)
2. CLI prompts for approval — operator confirms the service identity
3. Daemon generates an Ed25519 key pair for the service and stores the private key in the daemon's credential store
4. The service's public key is provided to the service **once** at registration time (displayed by CLI, or written to a file the service can read)
5. The daemon signs tokens with the service's private key; the service validates tokens using its public key

This means:

- No shared secrets in environment variables
- Each service has its own key pair — compromise of one service doesn't affect others
- Operator must explicitly approve each service before it can receive authenticated requests
- Key rotation is per-service via `shoggoth service rotate-key <id>`

Token claims (signed with the service's private key):

- `sub`: agent ID
- `scope`: service ID
- `iat` / `exp`: issued/expiry timestamps
- `session`: originating session URN (optional, for audit)

When a plugin tool proxies a request to its service, the daemon signs a short-lived token with that service's private key. The service validates it using the public key it received at registration.

### Data Flow: Agent Uses a Service Tool

1. Agent calls `canvas.push { surface: "main", nodes: [...] }` (a tool registered by the Canvas service)
2. Tool handler (registered dynamically from manifest) resolves the Canvas service URL from the registry
3. Registry returns `{ url: "http://127.0.0.1:3100", healthy: true }`
4. Tool handler mints a short-lived token signed with Canvas's private key
5. Tool handler dispatches the request to the service with `Authorization: Bearer <token>`
6. Canvas Web validates the token using its public key, processes the push, returns response
7. Tool handler returns the result to the agent

### Integration with Existing Systems

- **procman** — No changes to procman's core. The service registry listens to procman's `process-started` / `process-stopped` / `process-failed` events and maintains its own state.
- **Config schema** — `ProcessDeclaration` gains an optional `service` field. Backward compatible.
- **Tool registry** — Service tools are dynamically registered/deregistered based on service health. They coexist with builtin tools.
- **Shutdown** — Gateway drains connections before procman stops service processes. Registered as a separate drain phase.
- **CLI** — New `shoggoth service` subcommands for registration, approval, key rotation, and status.

### Service Contract (what services must implement)

A Shoggoth-managed web service must:

1. Listen on the port declared in the `service.port` config field (how the service determines its port is its own concern — env var, config file, hardcoded default, etc.)
2. Expose a health endpoint (path configurable in `health` config)
3. Validate `Authorization: Bearer <token>` headers using the public key provided during operator-approved registration
4. Expose a `GET /manifest` endpoint (path configurable via `service.manifestPath`) if it provides agent tools

The manifest endpoint is required for services that provide agent tools. It enables the daemon to dynamically register and describe tools without hardcoding knowledge of each service.

## Testing Strategy

- **Unit tests** for service registry (register, deregister, lookup by ID, lookup by capability, health state transitions)
- **Unit tests** for token minting and validation
- **Integration tests** for the full flow: procman starts a mock HTTP service → registry picks it up → manifest fetched → tools registered → agent invokes tool → request proxied → response returned
- **Integration tests** for gateway proxying with auth enforcement
- **Integration tests** for tool lifecycle: service goes unhealthy → tools deregistered → service recovers → tools re-registered
- **Manual verification** with Canvas Web as the first real service

## Considerations

- **Port conflicts** — Services declare their ports in config. The registry should detect conflicts at config validation time, not at runtime.
- **Hot reload** — If a service's config changes (port, basePath), the gateway must update its routing table. This ties into Shoggoth's existing config hot-reload mechanism.
- **Multi-tenant isolation** — In a multi-agent deployment, services may need to scope data by agent. The auth token provides identity; the service is responsible for isolation. This plan does not prescribe how services partition data internally.
- **WebSocket lifecycle** — Long-lived WebSocket connections between agents and services need cleanup when sessions end. The `service.stream` tool should tie connection lifetime to the session or provide explicit close semantics.
- **Gateway vs. direct access** — For development, direct port access is simpler. The gateway adds latency but provides auth and a single entry point. Both modes should be supported; `expose: "gateway" | "direct" | "both"` in config.
- **Future: service-to-agent callbacks** — A service may want to push events to an agent (e.g., "user clicked button"). This plan covers agent→service. Service→agent (callbacks/webhooks) is deferred but the registry and auth infrastructure support it.
- **Static file serving** — Canvas Web serves a Vue SPA. The gateway could serve static assets directly (bypassing the service process) for performance, but this adds complexity. Deferred to a future optimization pass.

## Migration

No existing data or configuration is affected. The `service` field on `ProcessDeclaration` is optional and additive. Existing `processes[]` entries without a `service` block continue to work unchanged.

## References

- [`spec.md`](spec.md) — type signatures, interfaces, and code examples
- [`implementation.md`](implementation.md) — phased implementation steps
- [procman plan](../done/2026-03-31_process-manager/README.md) — existing process manager design
- [per-agent MCP pool scope](../done/2026-05-04_per-agent-mcp-pool-scope/README.md) — prior art for scoped process identity
