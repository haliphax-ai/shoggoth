# Specification

## Interfaces

### External Service Declaration (config)

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
  /** Health check polling interval in ms. Default 30000. */
  healthIntervalMs?: number;
  /** Number of consecutive failures before marking unhealthy. Default 3. */
  unhealthyThreshold?: number;
}

type ExternalServiceHealthCheck =
  | { kind: "tcp"; port?: number; timeoutMs?: number }
  | { kind: "http"; url: string; expectedStatus?: number; timeoutMs?: number };
```

### ExternalServiceHealthPoller

```ts
interface HealthPollResult {
  serviceId: string;
  healthy: boolean;
  latencyMs: number;
  error?: string;
}

interface HealthPollerOptions {
  /** Polling interval in ms. */
  intervalMs: number;
  /** Consecutive failures before emitting unhealthy. Default 3. */
  unhealthyThreshold: number;
  /** Maximum backoff interval in ms. Default 300000 (5 min). */
  maxBackoffMs: number;
}

/**
 * Manages periodic health checks for external services.
 * Emits events on state transitions (healthy ↔ unhealthy).
 */
class ExternalServiceHealthPoller extends EventEmitter {
  constructor(logger: Logger);

  /** Start polling for a service. */
  add(declaration: ExternalServiceDeclaration): void;

  /** Stop polling for a service. */
  remove(serviceId: string): void;

  /** Update polling config for a service (e.g. on hot reload). */
  update(declaration: ExternalServiceDeclaration): void;

  /** Stop all pollers. */
  stopAll(): void;

  /** Get current health state for a service. */
  getState(serviceId: string): "healthy" | "unhealthy" | "unknown";

  // Events:
  //   "healthy" (serviceId: string, declaration: ExternalServiceDeclaration)
  //   "unhealthy" (serviceId: string, error: string)
}
```

### Health Check Implementations

```ts
interface HealthChecker {
  check(config: ExternalServiceHealthCheck, host: string, port: number): Promise<HealthPollResult>;
}

/** TCP health check — attempts socket connection. */
class TcpHealthChecker implements HealthChecker {
  async check(
    config: Extract<ExternalServiceHealthCheck, { kind: "tcp" }>,
    host: string,
    port: number,
  ): Promise<HealthPollResult>;
}

/** HTTP health check — sends GET request, checks status code. */
class HttpHealthChecker implements HealthChecker {
  async check(
    config: Extract<ExternalServiceHealthCheck, { kind: "http" }>,
    host: string,
    port: number,
  ): Promise<HealthPollResult>;
}
```

### ServiceLifecycleManager Extensions

```ts
/**
 * Extensions to ServiceLifecycleManager for external service support.
 * These methods are called by ExternalServiceHealthPoller events.
 */
interface ExternalServiceLifecycle {
  /** Called when an external service becomes healthy (first time or recovery). */
  onExternalServiceHealthy(id: string, declaration: ExternalServiceDeclaration): Promise<void>;

  /** Called when an external service becomes unhealthy. */
  onExternalServiceUnhealthy(id: string): void;

  /** Called on config hot reload to reconcile external service declarations. */
  reconcileExternalServices(declarations: ExternalServiceDeclaration[]): void;
}
```

## Data Structures / Schemas

### Config Schema (Zod)

```ts
const externalServiceHealthSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("tcp"),
    port: z.number().int().min(1).max(65535).optional(),
    timeoutMs: z.number().int().positive().optional().default(5000),
  }),
  z.object({
    kind: z.literal("http"),
    url: z.string().url(),
    expectedStatus: z.number().int().optional().default(200),
    timeoutMs: z.number().int().positive().optional().default(5000),
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
    unhealthyThreshold: z.number().int().positive().optional().default(3),
  })
  .strict();

// Top-level config addition:
// services: z.array(externalServiceDeclarationSchema).optional()
```

### ServiceEntry (external tier)

```ts
// Produced by ExternalServiceHealthPoller + ServiceLifecycleManager:
const externalServiceEntry: ServiceEntry = {
  id: "analytics-dashboard",
  label: "Analytics Dashboard",
  url: "http://10.0.1.50:8080",
  healthy: true,
  capabilities: ["analytics"],
  expose: "gateway",
  manifest: null, // populated after manifest fetch
  registeredTools: [], // populated after approval
  tier: "external",
};
```

### Config Example

```jsonc
{
  "services": [
    {
      "id": "analytics-dashboard",
      "label": "Analytics Dashboard",
      "host": "10.0.1.50",
      "port": 8080,
      "protocol": "http",
      "capabilities": ["analytics"],
      "expose": "gateway",
      "health": {
        "kind": "http",
        "url": "http://10.0.1.50:8080/health",
        "timeoutMs": 3000,
      },
      "healthIntervalMs": 15000,
      "unhealthyThreshold": 3,
    },
    {
      "id": "webhook-receiver",
      "label": "Webhook Receiver",
      "host": "localhost",
      "port": 9090,
      "protocol": "http",
      "basePath": "/hooks",
      "capabilities": ["webhooks"],
      "expose": "direct",
      "manifestPath": "/shoggoth/manifest",
      "health": {
        "kind": "tcp",
        "timeoutMs": 2000,
      },
      "healthIntervalMs": 10000,
    },
  ],
}
```

## Code Examples

### Health poller usage (daemon entrypoint)

```ts
import { ExternalServiceHealthPoller } from "./external-service-health-poller.js";

// During daemon startup:
const healthPoller = new ExternalServiceHealthPoller(logger);

// Wire events to lifecycle manager
healthPoller.on("healthy", (serviceId, declaration) => {
  lifecycleManager.onExternalServiceHealthy(serviceId, declaration);
});

healthPoller.on("unhealthy", (serviceId, error) => {
  lifecycleManager.onExternalServiceUnhealthy(serviceId);
});

// Start polling for each declared external service
for (const decl of config.services ?? []) {
  healthPoller.add(decl);
}

// On config hot reload:
configWatcher.on("reload", (newConfig) => {
  const newServices = newConfig.services ?? [];
  lifecycleManager.reconcileExternalServices(newServices);
});

// On shutdown:
healthPoller.stopAll();
```

### Lifecycle manager handling external service events

```ts
async onExternalServiceHealthy(id: string, declaration: ExternalServiceDeclaration): Promise<void> {
  const url = `http://${declaration.host}:${declaration.port}${declaration.basePath ?? "/"}`;

  const entry: ServiceEntry = {
    id,
    label: declaration.label ?? id,
    url: url.replace(/\/$/, ""),
    healthy: true,
    capabilities: declaration.capabilities ?? [],
    expose: declaration.expose ?? "direct",
    manifest: null,
    registeredTools: [],
    tier: "external",
  };

  this.registry.register(entry);

  // Fetch manifest for tool registration
  const manifestUrl = `${entry.url}${declaration.manifestPath ?? "/manifest"}`;
  const manifest = await this.manifestFetcher.fetch(manifestUrl);

  if (!manifest) {
    this.logger.warn(`Failed to fetch manifest for external service ${id}`);
    return;
  }

  entry.manifest = manifest;

  // Check approval (same logic as managed services)
  const fingerprint = this.computeFingerprint(manifest);
  const approval = await this.approvalStore.get(id);

  if (!approval || approval.status === "pending") {
    await this.approvalStore.createRequest(id, fingerprint, manifest);
    this.logger.info(`External service ${id} pending approval`);
    return;
  }

  if (approval.status === "revoked") {
    this.logger.warn(`External service ${id} is revoked — tools not registered`);
    return;
  }

  if (approval.fingerprint !== fingerprint) {
    await this.approvalStore.markPendingReapproval(id, fingerprint);
    this.toolRegistry.deregisterServiceTools(id);
    this.logger.info(`External service ${id} manifest changed — pending re-approval`);
    return;
  }

  // Approved and fingerprint matches — register tools
  this.registerToolsFromManifest(id, manifest);
}

onExternalServiceUnhealthy(id: string): void {
  this.toolRegistry.deregisterServiceTools(id);
  this.registry.markUnhealthy(id);
  this.logger.info(`External service ${id} marked unhealthy — tools removed`);
}
```

### Config hot reload reconciliation

```ts
reconcileExternalServices(declarations: ExternalServiceDeclaration[]): void {
  const currentIds = new Set(this.healthPoller.getTrackedIds());
  const newIds = new Set(declarations.map((d) => d.id));

  // Remove services no longer in config
  for (const id of currentIds) {
    if (!newIds.has(id)) {
      this.healthPoller.remove(id);
      this.toolRegistry.deregisterServiceTools(id);
      this.registry.deregister(id);
    }
  }

  // Add or update services
  for (const decl of declarations) {
    if (currentIds.has(decl.id)) {
      this.healthPoller.update(decl);
    } else {
      this.healthPoller.add(decl);
    }
  }
}
```

### TCP health check implementation

```ts
import * as net from "node:net";

async function checkTcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);

    socket.connect(port, host, () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });

    socket.on("error", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(false);
    });
  });
}
```

### HTTP health check implementation

```ts
async function checkHttp(url: string, expectedStatus: number, timeoutMs: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    return response.status === expectedStatus;
  } catch {
    return false;
  }
}
```
