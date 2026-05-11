# Specification

## Interfaces

### Service Declaration (config extension for managed services)

```ts
/** Extension to ProcessDeclaration for managed web service processes. */
interface ServiceDeclaration {
  /** Port the service listens on. */
  port: number;
  /** Protocol spoken by the service. */
  protocol: "http" | "ws" | "http+ws";
  /** Base path prefix for routing (default "/"). */
  basePath?: string;
  /** Named capabilities this service provides (for discovery). */
  capabilities?: string[];
  /** How the service is exposed externally. */
  expose?: "gateway" | "direct" | "both";
  /** Manifest endpoint path (default "/manifest"). Required for tool registration. */
  manifestPath?: string;
  /** Bind address override (default "127.0.0.1"). */
  host?: string;
}
```

### External Service Declaration (top-level `services[]`)

```ts
/** Declaration for an external service not managed by procman. */
interface ExternalServiceDeclaration {
  /** Unique ID for this service. */
  id: string;
  /** Human-readable label. */
  label?: string;
  /** Host where the service is running. */
  host: string;
  /** Port the service listens on. */
  port: number;
  /** Protocol spoken by the service. */
  protocol: "http" | "ws" | "http+ws";
  /** Base path prefix for routing (default "/"). */
  basePath?: string;
  /** Named capabilities this service provides (for discovery). */
  capabilities?: string[];
  /** How the service is exposed externally. */
  expose?: "gateway" | "direct" | "both";
  /** Manifest endpoint path (default "/manifest"). Required for tool registration. */
  manifestPath?: string;
  /** Health check configuration. */
  health: ExternalServiceHealthCheck;
  /** Health check polling interval (ms). Default 30000. */
  healthIntervalMs?: number;
}

type ExternalServiceHealthCheck =
  | { kind: "tcp"; port?: number; timeoutMs?: number }
  | { kind: "http"; url: string; expectedStatus?: number; timeoutMs?: number };
```

### Service Manifest (served by the service at its manifest endpoint)

```ts
/** Returned by GET /manifest on a Shoggoth-managed service. */
interface ServiceManifest {
  /** Service name. */
  name: string;
  /** Semantic version. */
  version: string;
  /** Tools this service provides to agents. */
  tools?: ServiceToolDeclaration[];
  /** Control plane operations this service requests access to. */
  ops?: string[];
  /** WebSocket endpoints (informational). */
  wsEndpoints?: ManifestWsEndpoint[];
}

/** A tool declared by a service, registered dynamically with the daemon. */
interface ServiceToolDeclaration {
  /** Tool name as exposed to agents (e.g. "canvas.push"). */
  name: string;
  /** Human-readable description for the tool descriptor. */
  description: string;
  /** JSON Schema for the tool's parameters. */
  parameters: JSONSchema;
  /** HTTP method to use when dispatching to the service. */
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Path on the service to dispatch to (e.g. "/api/a2ui/push"). */
  path: string;
  /** How to map tool args to the request. Default: "body". */
  dispatch?: "body" | "query" | "path";
}

interface ManifestWsEndpoint {
  path: string;
  description?: string;
  /** Message protocol (e.g. "jsonl", "json", "binary"). */
  protocol?: string;
}
```

### Service Registry

```ts
interface ServiceEntry {
  /** Process declaration ID. */
  id: string;
  /** Human-readable label. */
  label?: string;
  /** Resolved base URL (e.g. "http://127.0.0.1:3100"). */
  url: string;
  /** WebSocket URL if protocol includes ws. */
  wsUrl?: string;
  /** Current health state. */
  healthy: boolean;
  /** Declared capabilities. */
  capabilities: string[];
  /** Exposure mode. */
  expose: "gateway" | "direct" | "both";
  /** Fetched manifest (null if not yet fetched or fetch failed). */
  manifest: ServiceManifest | null;
  /** Tools currently registered for this service. */
  registeredTools: string[];
}

class ServiceRegistry extends EventEmitter {
  /** Register a service (called when procman reports healthy). */
  register(entry: ServiceEntry): void;

  /** Deregister a service (called on process stop/fail). */
  deregister(id: string): void;

  /** Mark a service as unhealthy; deregisters its tools. */
  markUnhealthy(id: string): void;

  /** Mark healthy and re-register tools from manifest. */
  markHealthy(id: string): void;

  /** Look up a service by ID. */
  get(id: string): ServiceEntry | undefined;

  /** Find services by capability. */
  findByCapability(capability: string): ServiceEntry[];

  /** List all registered services. */
  list(): ServiceEntry[];

  // Events: "registered", "deregistered", "health-changed", "tools-registered", "tools-deregistered"
}
```

### Auth & Control Plane Access

```ts
interface ServiceTokenPayload {
  /** Agent ID (subject). */
  sub: string;
  /** Target service ID. */
  scope: string;
  /** Issued-at (unix seconds). */
  iat: number;
  /** Expiry (unix seconds). */
  exp: number;
  /** Originating session URN (optional). */
  session?: string;
}

interface ServiceRegistration {
  /** Service ID. */
  id: string;
  /** Ed25519 public key (provided to the service). */
  publicKey: Ed25519PublicKey;
  /** Approved control plane operations. */
  approvedOps: string[];
  /** Whether the service has been approved by the operator. */
  approved: boolean;
}

interface ServiceKeyStore {
  /** Get the private key for signing tokens destined for a service. */
  getPrivateKey(serviceId: string): Ed25519PrivateKey | null;

  /** Generate and store a new key pair for a service. Returns the public key. */
  generateKeyPair(serviceId: string): Ed25519PublicKey;

  /** Rotate a service's key pair. Returns the new public key. */
  rotateKey(serviceId: string): Ed25519PublicKey;

  /** Check if a service has been approved (has a key pair). */
  isApproved(serviceId: string): boolean;

  /** Get the approved control plane operations for a service. */
  getApprovedOps(serviceId: string): string[];

  /** Set the approved operations (called during operator approval). */
  setApprovedOps(serviceId: string, ops: string[]): void;
}

interface TokenMinter {
  /** Mint a short-lived Ed25519-signed token for agent→service communication. */
  mint(agentId: string, serviceId: string, sessionUrn?: string): string;
}
}

interface TokenValidator {
  /** Validate and decode a service token using the service's public key. Returns null if invalid/expired. */
  validate(token: string, publicKey: Ed25519PublicKey): ServiceTokenPayload | null;
}
```

### Plugin Tool Dispatcher

```ts
/**
 * Handles tool calls for service-provided tools.
 * Registered dynamically when a service's manifest is fetched.
 */
interface ServiceToolDispatcher {
  /**
   * Dispatch a tool call to the backing service.
   * Mints auth token, builds HTTP request from tool declaration + args, returns response.
   */
  dispatch(
    toolDecl: ServiceToolDeclaration,
    args: Record<string, unknown>,
    ctx: { agentId: string; sessionUrn: string; serviceEntry: ServiceEntry },
  ): Promise<{ resultJson: string }>;
}
```

### Gateway Configuration

```ts
interface GatewayConfig {
  /** Whether the gateway is enabled. */
  enabled: boolean;
  /** Port the gateway listens on. */
  port: number;
  /** Bind address (default "0.0.0.0"). */
  host?: string;
  /** Path prefix for service routes (default "/svc"). */
  prefix?: string;
  /** CORS configuration. */
  cors?: {
    origins: string[];
    credentials?: boolean;
  };
  /** Rate limiting. */
  rateLimit?: {
    windowMs: number;
    maxRequests: number;
  };
}
```

## Data Structures / Schemas

### Config Schema (Zod — managed service extension to ProcessDeclaration)

```ts
const serviceDeclarationSchema = z
  .object({
    port: z.number().int().min(1).max(65535),
    protocol: z.enum(["http", "ws", "http+ws"]),
    basePath: z.string().optional().default("/"),
    capabilities: z.array(z.string().min(1)).optional(),
    expose: z.enum(["gateway", "direct", "both"]).optional().default("direct"),
    manifestPath: z.string().optional().default("/manifest"),
    host: z.string().optional().default("127.0.0.1"),
  })
  .strict();

// Added as optional field on processDeclarationSchema:
// service: serviceDeclarationSchema.optional()
```

### Config Schema (Zod — external services, top-level `services[]`)

```ts
const externalServiceHealthSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("tcp"),
    port: z.number().int().min(1).max(65535).optional(),
    timeoutMs: z.number().int().positive().optional(),
  }),
  z.object({
    kind: z.literal("http"),
    url: z.string().url(),
    expectedStatus: z.number().int().optional(),
    timeoutMs: z.number().int().positive().optional(),
  }),
]);

const externalServiceDeclarationSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1).optional(),
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    protocol: z.enum(["http", "ws", "http+ws"]),
    basePath: z.string().optional().default("/"),
    capabilities: z.array(z.string().min(1)).optional(),
    expose: z.enum(["gateway", "direct", "both"]).optional().default("direct"),
    manifestPath: z.string().optional().default("/manifest"),
    health: externalServiceHealthSchema,
    healthIntervalMs: z.number().int().positive().optional().default(30000),
  })
  .strict();

// Top-level config key: "services"
// services: z.array(externalServiceDeclarationSchema).optional()
```

### Gateway Config Schema

```ts
const gatewayConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    port: z.number().int().min(1).max(65535).default(8800),
    host: z.string().default("0.0.0.0"),
    prefix: z.string().default("/svc"),
    cors: z
      .object({
        origins: z.array(z.string()),
        credentials: z.boolean().optional(),
      })
      .optional(),
    rateLimit: z
      .object({
        windowMs: z.number().int().positive(),
        maxRequests: z.number().int().positive(),
      })
      .optional(),
  })
  .strict()
  .optional();

// Top-level config key: "gateway"
```

### Service Manifest Response Schema

```ts
const serviceToolDeclarationSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)*$/), // dotted namespace
  description: z.string().min(1),
  parameters: z.record(z.unknown()), // JSON Schema object
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().min(1),
  dispatch: z.enum(["body", "query", "path"]).optional().default("body"),
});

const serviceManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  tools: z.array(serviceToolDeclarationSchema).optional(),
  ops: z.array(z.string().min(1)).optional(),
  wsEndpoints: z
    .array(
      z.object({
        path: z.string().min(1),
        description: z.string().optional(),
        protocol: z.string().optional(),
      }),
    )
    .optional(),
});
```

## Code Examples

### Declaring a service in config

```jsonc
{
  "gateway": {
    "enabled": true,
    "port": 8800,
    "cors": { "origins": ["http://localhost:*"] },
  },
  "processes": [
    {
      "id": "canvas-web",
      "label": "Canvas Web",
      "startPolicy": "boot",
      "command": "node",
      "args": ["dist/server/index.js"],
      "cwd": "/opt/canvas-web",
      "env": { "PORT": "3100" },
      "restartMode": "on-failure",
      "health": { "kind": "http", "target": "http://localhost:3100/health" },
      "service": {
        "port": 3100,
        "protocol": "http+ws",
        "basePath": "/",
        "capabilities": ["canvas", "a2ui"],
        "expose": "gateway",
      },
    },
  ],
}
```

### Service manifest response (served by Canvas Web)

```json
{
  "name": "canvas-web",
  "version": "1.0.0",
  "tools": [
    {
      "name": "canvas.push",
      "description": "Push an A2UI surface to the canvas for rendering",
      "parameters": {
        "type": "object",
        "properties": {
          "surface": { "type": "string", "description": "Surface ID" },
          "nodes": { "type": "array", "description": "A2UI node tree" }
        },
        "required": ["surface", "nodes"]
      },
      "method": "POST",
      "path": "/api/a2ui/push"
    },
    {
      "name": "canvas.show",
      "description": "Navigate the canvas to a specific URL or file",
      "parameters": {
        "type": "object",
        "properties": {
          "url": { "type": "string", "description": "URL to display" }
        },
        "required": ["url"]
      },
      "method": "POST",
      "path": "/api/canvas/show"
    },
    {
      "name": "canvas.reset",
      "description": "Clear the current A2UI surface",
      "parameters": {
        "type": "object",
        "properties": {
          "surface": { "type": "string", "description": "Surface ID to clear" }
        },
        "required": ["surface"]
      },
      "method": "POST",
      "path": "/api/a2ui/reset"
    }
  ],
  "wsEndpoints": [
    {
      "path": "/ws",
      "description": "Client WebSocket for live UI updates",
      "protocol": "json"
    }
  ]
}
```

### Agent using a service-provided tool

```
// These tools appear in the agent's tool list automatically when Canvas is healthy:

canvas.push { surface: "main", nodes: [{ type: "text", content: "Hello world" }] }
// → { ok: true, surface: "main", nodeCount: 1 }

canvas.show { url: "/dashboard.html" }
// → { ok: true }

canvas.reset { surface: "main" }
// → { ok: true }
```

### Service validating a Shoggoth token (service-side code)

```ts
import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";

// Public key provided once during operator-approved registration
const PUBLIC_KEY = createPublicKey(readFileSync("./shoggoth-service.pub"));

function validateToken(authHeader: string): ServiceTokenPayload | null {
  const token = authHeader.replace("Bearer ", "");
  const [payloadB64, signatureB64] = token.split(".");
  const signature = Buffer.from(signatureB64, "base64url");
  const valid = verify(null, Buffer.from(payloadB64), PUBLIC_KEY, signature);
  if (!valid) return null;
  const payload: ServiceTokenPayload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}
```

### Tool dispatch flow (daemon internals)

```ts
// When agent calls "canvas.push { surface: "main", nodes: [...] }":

// 1. Look up tool declaration from registered service tools
const toolDecl = serviceToolRegistry.get("canvas.push");
// → { name: "canvas.push", method: "POST", path: "/api/a2ui/push", dispatch: "body", ... }

// 2. Resolve backing service
const entry = serviceRegistry.get(toolDecl.serviceId);
// → { url: "http://127.0.0.1:3100", healthy: true, ... }

// 3. Mint token
const token = tokenMinter.mint(ctx.agentId, entry.id, ctx.sessionUrn);

// 4. Dispatch
const response = await fetch(`${entry.url}${toolDecl.path}`, {
  method: toolDecl.method,
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify(args),
});

// 5. Return to agent
return { resultJson: await response.text() };
```
