# Specification

## Interfaces

### Service Declaration (config extension for managed processes)

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

### Service Registry

```ts
interface ServiceEntry {
  /** Service ID (matches the process ID). */
  id: string;
  /** Human-readable label. */
  label?: string;
  /** How this service was loaded. */
  tier: "plugin" | "managed" | "external";
  /**
   * Resolved base URL (e.g. "http://127.0.0.1:3100").
   * Null for plugin services that don't bind a port.
   */
  url: string | null;
  /** WebSocket URL if protocol includes ws. */
  wsUrl?: string;
  /** Current health state. */
  healthy: boolean;
  /** Declared capabilities. */
  capabilities: string[];
  /** Exposure mode. */
  expose: "gateway" | "direct" | "both";
  /** Fetched manifest (null if fetch failed or not yet fetched). */
  manifest: ServiceManifest | null;
  /** Tools currently registered for this service. */
  registeredTools: string[];
  /** Current approval status. */
  approvalStatus: "pending" | "approved" | "pending-reapproval" | "revoked";
}

class ServiceRegistry extends EventEmitter {
  /** Register a service. Throws if ID already exists. */
  register(entry: ServiceEntry): void;

  /** Deregister a service by ID. */
  deregister(id: string): void;

  /** Mark a service as unhealthy. Emits "health-changed". */
  markUnhealthy(id: string): void;

  /** Mark a service as healthy. Emits "health-changed". */
  markHealthy(id: string): void;

  /** Update approval status on a service entry. */
  setApprovalStatus(id: string, status: ServiceEntry["approvalStatus"]): void;

  /** Look up a service by ID. */
  get(id: string): ServiceEntry | undefined;

  /** Find services by capability. */
  findByCapability(capability: string): ServiceEntry[];

  /** List all registered services. */
  list(): ServiceEntry[];

  // Events: "registered", "deregistered", "health-changed", "approval-changed"
}
```

### Service Approval Store

```ts
type ApprovalStatus = "pending" | "approved" | "pending-reapproval" | "revoked";

interface ServiceApprovalRecord {
  /** Service ID. */
  serviceId: string;
  /** Current approval status. */
  status: ApprovalStatus;
  /** SHA-256 fingerprint of the approved manifest (null if never approved). */
  approvedFingerprint: string | null;
  /** ISO 8601 timestamp of last status change. */
  updatedAt: string;
  /** ISO 8601 timestamp of first registration. */
  createdAt: string;
}

interface ServiceApprovalStore {
  /** Get the approval record for a service. Returns null if never seen. */
  get(serviceId: string): ServiceApprovalRecord | null;

  /** Create or update an approval record. */
  upsert(serviceId: string, status: ApprovalStatus, fingerprint?: string): void;

  /** Approve a service, storing the current manifest fingerprint. */
  approve(serviceId: string, fingerprint: string): void;

  /** Revoke a service. */
  revoke(serviceId: string): void;

  /** List all records, optionally filtered by status. */
  list(status?: ApprovalStatus): ServiceApprovalRecord[];
}
```

### Manifest Fingerprinting

```ts
/**
 * Compute a deterministic fingerprint of a service manifest.
 * Used to detect changes that require re-approval.
 *
 * The fingerprint covers:
 * - tool names, descriptions, parameters, methods, paths
 * - capabilities (from config, not manifest)
 * - requested ops
 *
 * It does NOT cover:
 * - manifest name/version (informational)
 * - wsEndpoints (informational)
 */
function computeManifestFingerprint(manifest: ServiceManifest, capabilities: string[]): string;
```

### Service Tool Registry

```ts
/** A tool declared by a managed service in its manifest. */
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

type RegisteredServiceTool =
  | { kind: "http"; serviceId: string; decl: ServiceToolDeclaration }
  | { kind: "direct"; serviceId: string; tool: DirectServiceTool };

interface ServiceToolRegistry {
  /**
   * Register tools from a service manifest (HTTP proxy dispatch).
   * Each tool in the manifest becomes an HTTP proxy handler.
   */
  registerServiceTools(serviceId: string, manifest: ServiceManifest): void;

  /**
   * Register tools with direct dispatch (plugin services).
   * Handler functions are called in-process.
   */
  registerDirectTools(serviceId: string, tools: DirectServiceTool[]): void;

  /** Deregister all tools for a service. */
  deregisterServiceTools(serviceId: string): void;

  /** Look up a registered service tool by name. */
  get(toolName: string): RegisteredServiceTool | undefined;

  /** List all registered service tools (for injection into agent catalogs). */
  listTools(): RegisteredServiceTool[];

  /** Invoke a tool by name. Routes to direct handler or HTTP proxy. */
  invokeTool(
    toolName: string,
    args: Record<string, unknown>,
    ctx: { agentId: string; sessionUrn: string },
  ): Promise<{ resultJson: string }>;
}
```

### Service Tool Dispatcher

```ts
/**
 * HTTP proxy dispatcher for managed/external service tools.
 * Builds and sends HTTP requests based on tool declarations.
 */
interface ServiceToolDispatcher {
  /**
   * Dispatch a tool call to a managed/external service via HTTP.
   * Resolves service URL from registry, injects placeholder auth header,
   * sends request, returns response body.
   */
  dispatch(
    serviceId: string,
    decl: ServiceToolDeclaration,
    args: Record<string, unknown>,
    ctx: { agentId: string; sessionUrn: string },
  ): Promise<{ resultJson: string }>;
}
```

### Manifest Fetcher

```ts
/** Returned by GET /manifest on a managed service. */
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

interface ManifestWsEndpoint {
  path: string;
  description?: string;
  /** Message protocol (e.g. "jsonl", "json", "binary"). */
  protocol?: string;
}

interface ManifestFetcher {
  /**
   * Fetch and validate a service manifest.
   * Returns null on failure (logs warning). Caller should mark service unhealthy.
   * On success, stores the manifest on the registry entry.
   */
  fetchAndStore(serviceId: string, manifestPath?: string): Promise<ServiceManifest | null>;
}
```

### Service Lifecycle Manager

```ts
interface ServiceLifecycleManagerOpts {
  registry: ServiceRegistry;
  manifestFetcher: ManifestFetcher;
  toolRegistry: ServiceToolRegistry;
  approvalStore: ServiceApprovalStore;
  logger: Logger;
}

class ServiceLifecycleManager {
  constructor(opts: ServiceLifecycleManagerOpts);

  /**
   * Called when a process starts. If the process declares a service:
   * - Registers it in the service registry
   * - Fetches its manifest
   * - Checks approval status (fingerprint match)
   * - Only registers tools if approved with matching fingerprint
   */
  onProcessStarted(processId: string, declaration: ProcessDeclaration): Promise<void>;

  /**
   * Called when a process stops or fails.
   * Deregisters tools and the service entry.
   */
  onProcessStopped(processId: string): Promise<void>;

  /**
   * Called when a process health status changes.
   * Unhealthy: deregister tools.
   * Healthy: re-check approval, conditionally re-register tools.
   */
  onProcessHealthChanged(processId: string, healthy: boolean): Promise<void>;

  /**
   * Called by CLI when operator approves a service.
   * Stores fingerprint, registers tools if service is currently running.
   */
  onServiceApproved(serviceId: string): void;

  /**
   * Called by CLI when operator revokes a service.
   * Immediately deregisters tools.
   */
  onServiceRevoked(serviceId: string): void;

  /** Shutdown: deregister all managed services. */
  shutdown(): Promise<void>;
}
```

### Context Finalizer (Agent Integration)

```ts
/**
 * Session context finalizer that injects service tools into the agent's
 * tool catalog. Called during session context resolution.
 * Only includes tools from approved services.
 */
function serviceToolFinalizer(ctx: SessionMcpContext): SessionMcpContext;
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

const manifestWsEndpointSchema = z.object({
  path: z.string().min(1),
  description: z.string().optional(),
  protocol: z.string().optional(),
});

const serviceManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  tools: z.array(serviceToolDeclarationSchema).optional(),
  ops: z.array(z.string().min(1)).optional(),
  wsEndpoints: z.array(manifestWsEndpointSchema).optional(),
});
```

### State DB Migration — `service_approvals` table

```sql
CREATE TABLE IF NOT EXISTS service_approvals (
  service_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  approved_fingerprint TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### Port Conflict Validation

```ts
/**
 * Validates that no two managed services declare the same port on the same host.
 * Called during config loading. Throws with a descriptive error on conflict.
 */
function validateServicePortConflicts(processes: ProcessDeclaration[]): void;
```

## Code Examples

### Declaring a managed service in config

```jsonc
{
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

### Service manifest response (served by the managed process)

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
    }
  ],
  "ops": ["turn.invoke"],
  "wsEndpoints": [
    {
      "path": "/ws",
      "description": "Client WebSocket for live UI updates",
      "protocol": "json"
    }
  ]
}
```

### Approval flow (CLI interaction)

```
$ shoggoth service list
ID           TIER      STATUS              TOOLS  CAPABILITIES
canvas-web   managed   pending             0      canvas, a2ui

$ shoggoth service requests
ID           TIER      STATUS    TOOLS  OPS
canvas-web   managed   pending   1      turn.invoke

$ shoggoth service request canvas-web
Service: canvas-web (managed)
Status:  pending (first-time approval required)

Capabilities: canvas, a2ui
Requested ops: turn.invoke

Tools (1):
  canvas.push  POST /api/a2ui/push
    Push an A2UI surface to the canvas for rendering

$ shoggoth service approve canvas-web
Approved service "canvas-web" with 1 tool(s) and 1 op(s).
Tools are now active for agents.

$ shoggoth service list
ID           TIER      STATUS     TOOLS  CAPABILITIES
canvas-web   managed   approved   1      canvas, a2ui
```

### Re-approval after manifest change

```
$ shoggoth service list
ID           TIER      STATUS               TOOLS  CAPABILITIES
canvas-web   managed   pending-reapproval   0      canvas, a2ui

$ shoggoth service request canvas-web
Service: canvas-web (managed)
Status:  pending-reapproval (manifest changed since last approval)

Changes detected:
  + canvas.reset  POST /api/a2ui/reset (new tool)

Capabilities: canvas, a2ui
Requested ops: turn.invoke

Tools (2):
  canvas.push   POST /api/a2ui/push
  canvas.reset  POST /api/a2ui/reset

$ shoggoth service approve canvas-web
Approved service "canvas-web" with 2 tool(s) and 1 op(s).
Tools are now active for agents.
```

### Tool dispatch flow (daemon internals)

```ts
// When agent calls "canvas.push { surface: "main", nodes: [...] }":

// 1. Look up registered tool
const registered = serviceToolRegistry.get("canvas.push");
if (!registered) throw new Error("unknown tool");

if (registered.kind === "http") {
  // Managed service — HTTP proxy
  const entry = serviceRegistry.get(registered.serviceId)!;
  if (!entry.healthy) throw new Error("service unhealthy");

  const response = await fetch(`${entry.url}${registered.decl.path}`, {
    method: registered.decl.method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${placeholderToken}`,
    },
    body: JSON.stringify(args),
  });

  return { resultJson: await response.text() };
}
```

### Daemon wiring (procman event subscription)

```ts
// In daemon index.ts, after procman is initialized:

const serviceLifecycle = new ServiceLifecycleManager({
  registry: serviceRegistry,
  manifestFetcher,
  toolRegistry: serviceToolRegistry,
  approvalStore,
  logger: getLogger("service-lifecycle"),
});

// Map process declarations by ID for lookup on events
const processDeclarations = new Map((config.processes ?? []).map((d) => [d.id, d]));

procman.on("process-started", (processId: string) => {
  const decl = processDeclarations.get(processId);
  if (decl) void serviceLifecycle.onProcessStarted(processId, decl);
});

procman.on("process-stopped", (processId: string) => {
  void serviceLifecycle.onProcessStopped(processId);
});

procman.on("process-failed", (processId: string) => {
  void serviceLifecycle.onProcessStopped(processId);
});

procman.on("health-changed", (processId: string, healthy: boolean) => {
  void serviceLifecycle.onProcessHealthChanged(processId, healthy);
});

rt.shutdown.registerDrain("service-lifecycle", () => serviceLifecycle.shutdown());
```

### Manifest fingerprinting

```ts
import { createHash } from "node:crypto";

function computeManifestFingerprint(manifest: ServiceManifest, capabilities: string[]): string {
  // Build a canonical representation of approval-relevant fields
  const canonical = {
    tools: (manifest.tools ?? [])
      .map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        method: t.method,
        path: t.path,
        dispatch: t.dispatch ?? "body",
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    ops: [...(manifest.ops ?? [])].sort(),
    capabilities: [...capabilities].sort(),
  };

  const json = JSON.stringify(canonical);
  return createHash("sha256").update(json).digest("hex");
}
```
