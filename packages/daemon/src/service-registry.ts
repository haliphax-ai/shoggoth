import { EventEmitter } from "node:events";

/**
 * Service manifest returned by GET /manifest on a managed service.
 */
export interface ServiceManifest {
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

/**
 * WebSocket endpoint in a service manifest.
 */
export interface ManifestWsEndpoint {
  path: string;
  description?: string;
  /** Message protocol (e.g. "jsonl", "json", "binary"). */
  protocol?: string;
}

/**
 * A tool declared by a managed service in its manifest.
 */
export interface ServiceToolDeclaration {
  /** Tool name as exposed to agents (e.g. "canvas.push"). */
  name: string;
  /** Human-readable description for the tool descriptor. */
  description: string;
  /** JSON Schema for the tool's parameters. */
  parameters: Record<string, unknown>;
  /** HTTP method to use when dispatching to the service. */
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Path on the service to dispatch to (e.g. "/api/a2ui/push"). */
  path: string;
  /** How to map tool args to the request. Default: "body". */
  dispatch?: "body" | "query" | "path";
}

/**
 * Approval status for a service.
 */
export type ApprovalStatus = "pending" | "approved" | "pending-reapproval" | "revoked";

/**
 * Service entry representing a registered service.
 */
export interface ServiceEntry {
  /** Unique identifier for this service. */
  id: string;
  /** Human-readable label. */
  label?: string;
  /** How this service was loaded. */
  tier: "plugin" | "managed" | "external";
  /** Base URL for HTTP access. Null for plugin services that don't bind a port. */
  url: string | null;
  /** WebSocket URL (if applicable). */
  wsUrl?: string;
  /** Whether the service is currently healthy. */
  healthy: boolean;
  /** Capabilities advertised by this service. */
  capabilities: string[];
  /** How this service is exposed. */
  expose: "gateway" | "direct" | "both";
  /** Fetched manifest (null if fetch failed or not yet fetched). */
  manifest: ServiceManifest | null;
  /** List of tools registered from this service. */
  registeredTools: string[];
  /** Current approval status. */
  approvalStatus: ApprovalStatus;
}

/**
 * Service registry for managing plugin service declarations.
 * Tracks service health, capabilities, and registered tools.
 */
export class ServiceRegistry extends EventEmitter {
  private services = new Map<string, ServiceEntry>();

  /**
   * Register a new service entry.
   * @throws Error if a service with the same ID is already registered
   */
  register(entry: ServiceEntry): void {
    if (this.services.has(entry.id)) {
      throw new Error(`Service with id "${entry.id}" is already registered`);
    }
    this.services.set(entry.id, entry);
    this.emit("registered", entry);
  }

  /**
   * Deregister a service by ID.
   */
  deregister(id: string): void {
    if (this.services.has(id)) {
      this.services.delete(id);
      this.emit("deregistered", id);
    }
  }

  /**
   * Mark a service as unhealthy.
   */
  markUnhealthy(id: string): void {
    const entry = this.services.get(id);
    if (entry) {
      entry.healthy = false;
      this.emit("health-changed", { id, healthy: false });
    }
  }

  /**
   * Mark a service as healthy.
   */
  markHealthy(id: string): void {
    const entry = this.services.get(id);
    if (entry) {
      entry.healthy = true;
      this.emit("health-changed", { id, healthy: true });
    }
  }

  /**
   * Update approval status on a service entry.
   * Emits "approval-changed" event.
   */
  setApprovalStatus(id: string, status: ApprovalStatus): void {
    const entry = this.services.get(id);
    if (entry) {
      entry.approvalStatus = status;
      this.emit("approval-changed", { id, status });
    }
  }

  /**
   * Get a service entry by ID.
   */
  get(id: string): ServiceEntry | undefined {
    return this.services.get(id);
  }

  /**
   * Find all services that advertise a specific capability.
   */
  findByCapability(cap: string): ServiceEntry[] {
    return this.list().filter((entry) => entry.capabilities.includes(cap));
  }

  /**
   * List all registered services.
   */
  list(): ServiceEntry[] {
    return Array.from(this.services.values());
  }
}
