import { EventEmitter } from "node:events";

/**
 * Service entry representing a registered service.
 */
export interface ServiceEntry {
  /** Unique identifier for this service. */
  id: string;
  /** Human-readable label. */
  label?: string;
  /** How this service was loaded. */
  tier: "plugin";
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
  /** List of tools registered from this service. */
  registeredTools: string[];
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
