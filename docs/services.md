# Shoggoth Services

## Overview

Services extend Shoggoth's capabilities by exposing tools that agents can invoke. A service is any process (or in-process module) that declares tools via a manifest and registers them with the daemon. The daemon handles discovery, approval, health monitoring, and authenticated tool dispatch.

Services exist because not everything belongs in the daemon process. A weather API wrapper, a code execution sandbox, a web UI — these are better as standalone processes with clear boundaries. The service system gives them a structured way to integrate with Shoggoth while maintaining isolation and operator control.

### The Three Tiers

| Tier         | Where it runs       | Auth mechanism              | Use case                                        |
| ------------ | ------------------- | --------------------------- | ----------------------------------------------- |
| **Plugin**   | In-process (daemon) | None (direct function call) | Tightly coupled features, platform integrations |
| **Managed**  | Spawned by procman  | age X25519 tokens           | Self-contained services the daemon controls     |
| **External** | Operator-managed    | age X25519 tokens           | Pre-existing services, shared infrastructure    |

All three tiers share the same approval flow: the operator must explicitly approve a service before its tools become available to agents.

---

## Service Tiers

### Plugin Services

Plugin services run inside the daemon process. They register via the `service.register` lifecycle hook and provide tools as direct function calls — no HTTP, no serialization overhead.

Because they execute in-process, plugin services don't need cryptographic authentication on tool calls. However, they still require operator approval, must declare their intended operations (`ops`), and are fingerprinted to detect changes.

### Managed Services

Managed services are spawned and supervised by the daemon's process manager (procman). You declare them in the `processes` config block with a `service` sub-object. The daemon:

1. Spawns the process
2. Waits for it to become healthy (health check endpoint)
3. Fetches its manifest
4. Computes a fingerprint
5. Registers tools (if approved)

If the process crashes, procman restarts it. If the manifest changes, the service enters `pending-reapproval` until the operator re-approves.

### External Services

External services are not spawned by the daemon. They run wherever the operator puts them — a separate host, a container, a cloud function. The daemon only knows their address and polls their health endpoint.

Declare them in the `externalServices` config block. The lifecycle is the same as managed services (manifest fetch → fingerprint → approval → tool registration) but the daemon doesn't control the process lifecycle.

---

## Lifecycle

### Registration

When a service becomes available (process starts, external service becomes healthy, or plugin loads), the daemon registers it in the `ServiceRegistry`:

```
Process starts / health check passes
  → ServiceLifecycleManager.onProcessStarted() or onExternalServiceHealthy()
    → registry.register(entry)
    → manifestFetcher.fetchAndStore(id, manifestPath)
    → checkApprovalAndRegisterTools()
```

### Manifest Fetching

The daemon fetches the manifest from the service's manifest endpoint (default: `GET /manifest`). The manifest declares the service's name, version, tools, and ops:

```json
{
  "name": "demo",
  "version": "1.0.0",
  "tools": [
    {
      "name": "demo.set_message",
      "description": "Set the displayed message",
      "parameters": {
        "type": "object",
        "properties": {
          "message": { "type": "string", "description": "The new message" }
        },
        "required": ["message"]
      },
      "method": "POST",
      "path": "/api/set_message",
      "dispatch": "body"
    }
  ],
  "ops": []
}
```

### Fingerprinting

A fingerprint is computed from the manifest contents and service metadata (tier, URL, capabilities). This fingerprint is stored when the operator approves the service. On subsequent startups, if the fingerprint doesn't match the stored approval, the service enters `pending-reapproval` and its tools are suspended.

This prevents a service from silently adding new tools or changing behavior without operator awareness.

### Approval Flow

```
New service detected → status: "pending"
  → Operator runs: shoggoth service approve <id>
    → Fingerprint stored
    → Tools registered
    → Status: "approved"

Manifest changes → status: "pending-reapproval"
  → Tools suspended until operator re-approves

Operator revokes → status: "revoked"
  → Tools deregistered immediately
```

---

## Authentication

Managed and external services use age X25519 key pairs for mutual authentication. Plugin services are exempt (in-process calls can't be impersonated).

### Key Pairs

Each approved managed/external service receives a unique age X25519 key pair:

- **Recipient (public key)** — stored by the daemon, used to encrypt tokens
- **Identity (private key)** — delivered to the service, used to decrypt tokens

The daemon never persists private keys. They are generated, delivered, and discarded.

### Token Flow

When an agent invokes a service tool:

```
Agent calls tool
  → ServiceToolDispatcher.dispatch()
    → TokenMinter.mint(agentId, serviceId, sessionUrn)
      → Builds payload: { sub, scope, iat, exp, session }
      → Encrypts with age to the service's recipient (public key)
      → Encodes as base64url
    → Sends HTTP request with Authorization: Bearer <token>

Service receives request
  → Extracts Bearer token
  → TokenValidator.validate(token, identityString)
    → Decodes base64url → age ciphertext
    → Decrypts with service's identity (private key)
    → Parses JSON, checks expiry
    → Returns { sub, scope, session } or null
```

Tokens expire after 5 minutes. This limits replay attacks while tolerating reasonable clock skew.

### Provision Secret Delivery (Managed Services)

Initial key delivery uses a one-time secret injected by procman:

1. Procman spawns service with `SHOGGOTH_PROVISION_SECRET=<random>` env var
2. Service starts, exposes `POST /_shoggoth/identity`
3. Daemon calls the endpoint with `X-Provision-Secret: <random>` header and the private key in the body
4. Service validates the secret matches its env var, stores the key
5. Daemon stores only the public key (recipient)

### Key Delivery (External Services)

External services can't receive automatic key delivery (no secure channel). The CLI displays the private key at approval time for the operator to deliver manually (SSH, secrets manager, etc.).

### Key Rotation

Rotation uses the existing authenticated channel:

1. Operator runs `shoggoth service rotate-key <id>`
2. Daemon pauses tool dispatch to this service
3. Generates new key pair
4. Mints a rotation token using the _current_ recipient (proves daemon identity)
5. Calls `POST /_shoggoth/identity` with `Authorization: Bearer <rotation-token>` and new private key
6. Service validates the rotation token with its current identity, stores new key
7. Daemon replaces stored recipient, resumes dispatch

If the service is unreachable, the CLI displays the new key for manual delivery.

---

## Configuration

### Managed Services

Declare managed services in the `processes` config block. Add a `service` sub-object to any process declaration:

```json
{
  "processes": [
    {
      "id": "demo",
      "label": "Demo Service",
      "command": "npx tsx packages/service-demo/src/server.ts",
      "service": {
        "port": 3200,
        "host": "127.0.0.1",
        "protocol": "http",
        "basePath": "/",
        "manifestPath": "/manifest",
        "expose": "direct",
        "capabilities": []
      }
    }
  ]
}
```

| Field          | Default     | Description                              |
| -------------- | ----------- | ---------------------------------------- |
| `port`         | (required)  | Port the service listens on              |
| `host`         | `127.0.0.1` | Bind address                             |
| `protocol`     | `http`      | `http`, `ws`, or `http+ws`               |
| `basePath`     | `/`         | URL prefix for all endpoints             |
| `manifestPath` | `/manifest` | Path to the manifest endpoint            |
| `expose`       | `direct`    | How tools are exposed to agents          |
| `capabilities` | `[]`        | Declared capabilities for fingerprinting |

### External Services

Declare external services in the `externalServices` config block:

```json
{
  "externalServices": [
    {
      "id": "analytics",
      "label": "Analytics Service",
      "host": "10.0.1.50",
      "port": 8080,
      "basePath": "/",
      "manifestPath": "/manifest",
      "healthPath": "/health",
      "expose": "direct",
      "capabilities": []
    }
  ]
}
```

The daemon polls the health endpoint and triggers the lifecycle flow when the service becomes reachable.

---

## Writing a Service

### Minimal Implementation

A Shoggoth service needs three things:

1. A manifest endpoint (`GET /manifest`)
2. An identity provisioning endpoint (`POST /_shoggoth/identity`)
3. Tool endpoints matching the manifest declarations

### Using `@shoggoth/service-auth`

The `@shoggoth/service-auth` package provides token validation, auth middleware, and identity handling:

```ts
import { createIdentityHandler, TokenValidator } from "@shoggoth/service-auth";

let identity: string | null = null;

// Identity provisioning — handles both initial delivery and rotation
const identityHandler = createIdentityHandler({
  provisionSecret: process.env.SHOGGOTH_PROVISION_SECRET || undefined,
  onReceive(id: string) {
    identity = id;
    console.log("Identity received, service is ready");
  },
});
```

### Token Validation on Tool Endpoints

Protect your tool endpoints by validating the Bearer token:

```ts
import { TokenValidator } from "@shoggoth/service-auth";

// In your request handler:
const authHeader = req.headers["authorization"];
if (!authHeader?.startsWith("Bearer ")) {
  return res.status(401).json({ error: "missing authorization" });
}

const token = authHeader.slice(7);
if (!identity) {
  return res.status(401).json({ error: "identity not provisioned" });
}

const payload = await TokenValidator.validate(token, identity);
if (!payload) {
  return res.status(401).json({ error: "invalid or expired token" });
}

// payload.sub = agent ID
// payload.scope = authorized scope
// payload.session = session URN
```

### Manifest Format

```ts
interface ServiceManifest {
  name: string;
  version: string;
  tools: ServiceToolDeclaration[];
  ops: string[]; // Control plane operations this service needs
}

interface ServiceToolDeclaration {
  name: string; // Unique tool name (convention: "service.action")
  description: string; // Shown to agents
  parameters: object; // JSON Schema for tool arguments
  method: string; // HTTP method: GET, POST, PUT, DELETE
  path: string; // Endpoint path (relative to service base URL)
  dispatch: "body" | "query" | "path"; // How args are sent
}
```

**Dispatch modes:**

- `body` — Arguments sent as JSON request body (falls back to query params for GET/HEAD)
- `query` — Arguments sent as URL query parameters
- `path` — Arguments interpolated into the path (e.g., `/users/{id}`)

### Required Endpoints

| Endpoint              | Method | Purpose                                    |
| --------------------- | ------ | ------------------------------------------ |
| `/manifest`           | GET    | Returns the service manifest               |
| `/_shoggoth/identity` | POST   | Receives identity key from daemon          |
| `/health`             | GET    | Health check (return 200 with body `"ok"`) |

### Reference Implementation

See `packages/service-demo/src/server.ts` for a complete working example that demonstrates:

- Manifest serving
- Identity provisioning (initial + rotation)
- Token validation on API routes
- Tool endpoint implementation

---

## CLI Commands

### `shoggoth service list`

List all registered services with their tier, health status, and approval state.

### `shoggoth service requests`

Show pending approval requests (services waiting for operator action).

### `shoggoth service approve <id>`

Approve a service. For managed/external services, this generates an age key pair and delivers the private key to the service (or displays it for manual delivery). Stores the manifest fingerprint.

### `shoggoth service revoke <id>`

Revoke a service's approval. Immediately deregisters all its tools and deletes key material. The service remains running but cannot serve tool calls.

### `shoggoth service rotate-key <id>`

Generate a new key pair for a managed/external service. Attempts automatic delivery via the identity endpoint. Falls back to CLI display if the service is unreachable.

---

## Plugin Services

Plugins register services via the `service.register` lifecycle hook:

```ts
// In a plugin's setup:
system.lifecycle["service.register"].tap(async (ctx) => {
  ctx.registerService({
    id: "my-plugin-service",
    label: "My Plugin Service",
    capabilities: ["some-capability"],
    expose: "direct",
  });

  ctx.registerTools([
    {
      name: "my-plugin.do_thing",
      description: "Does a thing",
      parameters: { type: "object", properties: {} },
      invoke: async (args, invokeCtx) => {
        return { result: "done" };
      },
    },
  ]);
});
```

### Fingerprinting

Plugin fingerprints are computed from the sorted, serialized tool declarations and ops array — not from file contents or load order. This ensures deterministic fingerprints across daemon restarts.

If a plugin update changes its tools or ops, the fingerprint changes and the plugin enters `pending-reapproval`. Its tools are suspended until the operator re-approves.

### Ops Enforcement

All services (including plugins) must declare their intended control plane operations in the `ops` array. At runtime, every operation is checked against the approved ops list. Unauthorized operations are rejected.

This is defense-in-depth for plugins — they run in-process so they can't be impersonated, but ops enforcement prevents a buggy plugin from accessing operations it never declared.
