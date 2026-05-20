import type { ShoggothConfig, ProcessDeclaration } from "@shoggoth/shared";
import { type ExternalServiceDeclaration } from "./external-service-health-poller";
import { ServiceRegistry, type ServiceEntry } from "./service-registry";
import { ServiceToolRegistry } from "./service-tool-registry";
import type { ShoggothPluginSystem } from "@shoggoth/plugins";
import type { PluginServiceEntry, DirectServiceTool, ServiceRegisterCtx } from "@shoggoth/plugins";

/**
 * Create a new ServiceRegistry instance.
 */
export function createServiceRegistry(): ServiceRegistry {
  return new ServiceRegistry();
}

/**
 * Create a new ServiceToolRegistry instance.
 */
export function createServiceToolRegistry(
  registry: ServiceRegistry,
  dispatcher?: ConstructorParameters<typeof ServiceToolRegistry>[1],
): ServiceToolRegistry {
  return new ServiceToolRegistry(registry, dispatcher);
}

export interface FireServiceRegisterHookOptions {
  spawnSession?: ServiceRegisterCtx["spawnSession"];
}

/**
 * Fire the service.register hook to allow plugin services to register themselves.
 * This should be called after plugins are loaded but before daemon.ready fires.
 *
 * @param system - The plugin system
 * @param registry - The service registry
 * @param toolRegistry - The service tool registry
 * @param config - The resolved config (after daemon.configure waterfall)
 * @param opts - Optional capabilities to expose to service plugins
 */
export async function fireServiceRegisterHook(
  system: ShoggothPluginSystem,
  registry: ServiceRegistry,
  toolRegistry: ServiceToolRegistry,
  config: ShoggothConfig,
  opts?: FireServiceRegisterHookOptions,
): Promise<void> {
  let lastRegisteredServiceId: string | undefined;

  const ctx: ServiceRegisterCtx = {
    registerService: (entry: PluginServiceEntry): void => {
      // Build URL if port is provided
      let url: string | null = null;
      if (entry.port) {
        const protocol = entry.protocol ?? "http";
        const basePath = entry.basePath ?? "/";
        const host = "localhost"; // Plugin services bind to localhost
        url = `${protocol}://${host}:${entry.port}${basePath === "/" ? "" : basePath}`;
      }

      const serviceEntry: ServiceEntry = {
        id: entry.id,
        label: entry.label,
        tier: "plugin",
        url,
        wsUrl:
          entry.port && (entry.protocol === "ws" || entry.protocol === "http+ws")
            ? `ws://localhost:${entry.port}${(entry.basePath ?? "/") === "/" ? "" : entry.basePath}`
            : undefined,
        healthy: true,
        capabilities: entry.capabilities ?? [],
        expose: entry.expose ?? "direct",
        manifest: null,
        registeredTools: [],
        approvalStatus: "approved",
      };

      registry.register(serviceEntry);
      lastRegisteredServiceId = entry.id;
    },
    registerTools: (tools: DirectServiceTool[]): void => {
      if (!lastRegisteredServiceId) {
        throw new Error("registerTools called before registerService");
      }
      toolRegistry.registerDirectTools(lastRegisteredServiceId, tools);
    },
    config: config as Readonly<ShoggothConfig>,
    spawnSession: opts?.spawnSession,
  };

  // Fire the async hook - plugins can implement this as async
  await system.lifecycle["service.register"].emit(ctx);
}

// ---------------------------------------------------------------------------
// Service Lifecycle Manager
// ---------------------------------------------------------------------------

import { ManifestFetcher } from "./manifest-fetcher";
import { ServiceApprovalStore } from "./service-approval-store";
import { computeManifestFingerprint } from "./manifest-fingerprint";

/**
 * Logger interface for ServiceLifecycleManager.
 */
export interface ServiceLifecycleLogger {
  debug: (msg: string, ...args: unknown[]) => void;
  warn: (msg: string, ...args: unknown[]) => void;
  info: (msg: string, ...args: unknown[]) => void;
}

/**
 * Options for creating a ServiceLifecycleManager.
 */
export interface ServiceLifecycleManagerOpts {
  /** Service registry for managing service entries. */
  registry: ServiceRegistry;
  /** Manifest fetcher for retrieving service manifests. */
  manifestFetcher: ManifestFetcher;
  /** Tool registry for managing service tools. */
  toolRegistry: ServiceToolRegistry;
  /** Approval store for service approval records. */
  approvalStore: ServiceApprovalStore;
  /** Logger for debug/warn/info output. */
  logger: ServiceLifecycleLogger;
}

/**
 * ServiceLifecycleManager handles the lifecycle of managed services:
 * - Registers services when processes start
 * - Fetches and validates manifests
 * - Manages approval state and tool registration
 * - Handles health changes and shutdown
 */
export class ServiceLifecycleManager {
  private registry: ServiceRegistry;
  private manifestFetcher: ManifestFetcher;
  private toolRegistry: ServiceToolRegistry;
  private approvalStore: ServiceApprovalStore;
  private logger: ServiceLifecycleLogger;

  constructor(opts: ServiceLifecycleManagerOpts) {
    this.registry = opts.registry;
    this.manifestFetcher = opts.manifestFetcher;
    this.toolRegistry = opts.toolRegistry;
    this.approvalStore = opts.approvalStore;
    this.logger = opts.logger;
  }

  /**
   * Called when a process starts. If the process declares a service:
   * - Registers it in the service registry
   * - Fetches its manifest
   * - Checks approval status (fingerprint match)
   * - Only registers tools if approved with matching fingerprint
   */
  async onProcessStarted(processId: string, declaration: ProcessDeclaration): Promise<void> {
    // Skip if no service block
    if (!declaration.service) {
      return;
    }

    const service = declaration.service;
    const host = service.host ?? "127.0.0.1";
    const port = service.port;
    const basePath = service.basePath ?? "/";
    const url = `${service.protocol === "ws" ? "http" : "http"}://${host}:${port}${basePath === "/" ? "" : basePath}`;

    // Register service in registry
    const entry: ServiceEntry = {
      id: processId,
      label: declaration.label,
      tier: "managed",
      url,
      wsUrl:
        service.protocol === "ws" || service.protocol === "http+ws"
          ? `ws://${host}:${port}${basePath === "/" ? "" : basePath}`
          : undefined,
      healthy: true,
      capabilities: service.capabilities ?? [],
      expose: service.expose ?? "direct",
      manifest: null,
      registeredTools: [],
      approvalStatus: "pending",
    };

    this.registry.register(entry);

    // Fetch manifest
    const manifest = await this.manifestFetcher.fetchAndStore(
      processId,
      service.manifestPath ?? "/manifest",
    );

    if (!manifest) {
      // Manifest fetch failed - still pending approval
      return;
    }

    // Check approval status
    await this.checkApprovalAndRegisterTools(processId, manifest, entry.capabilities);
  }

  /**
   * Check approval status and conditionally register tools.
   */
  private async checkApprovalAndRegisterTools(
    processId: string,
    manifest: NonNullable<Awaited<ReturnType<typeof this.manifestFetcher.fetchAndStore>>>,
    capabilities: string[],
  ): Promise<void> {
    const entry = this.registry.get(processId);
    if (!entry) return;

    const approval = this.approvalStore.get(processId);
    const currentFingerprint = computeManifestFingerprint(manifest, capabilities, {
      tier: entry.tier,
      url: entry.url,
    });

    if (!approval) {
      // Never seen - pending initial approval
      this.approvalStore.upsert(processId, "pending");
      this.registry.setApprovalStatus(processId, "pending");
      return;
    }

    if (approval.status === "revoked") {
      this.registry.setApprovalStatus(processId, "revoked");
      return;
    }

    if (approval.status === "approved") {
      if (approval.approvedFingerprint === currentFingerprint) {
        // Fingerprint matches - approve and register tools
        this.registry.setApprovalStatus(processId, "approved");
        this.registerTools(processId, manifest);
      } else {
        // Fingerprint changed - needs re-approval
        this.registry.setApprovalStatus(processId, "pending-reapproval");
      }
      return;
    }

    if (approval.status === "pending" || approval.status === "pending-reapproval") {
      // Already in a pending state
      return;
    }
  }

  /**
   * Register tools for a service.
   */
  private registerTools(
    serviceId: string,
    manifest: NonNullable<Awaited<ReturnType<typeof this.manifestFetcher.fetchAndStore>>>,
  ): void {
    const registered = this.toolRegistry.registerServiceTools(serviceId, manifest);
    this.logger.debug(`Registered ${registered.length} tools for service "${serviceId}"`);
  }

  /**
   * Called when a process stops or fails.
   * Deregisters tools and the service entry.
   */
  async onProcessStopped(processId: string): Promise<void> {
    // Deregister tools first
    this.toolRegistry.deregisterServiceTools(processId);

    // Deregister service
    this.registry.deregister(processId);
    this.logger.debug(`Service "${processId}" stopped and deregistered`);
  }

  /**
   * Called when a process health status changes.
   * Unhealthy: deregister tools.
   * Healthy: re-check approval, conditionally re-register tools.
   */
  async onProcessHealthChanged(processId: string, healthy: boolean): Promise<void> {
    const entry = this.registry.get(processId);
    if (!entry) return;

    if (healthy) {
      // Re-check approval store and conditionally register tools
      if (entry.manifest) {
        await this.checkApprovalAndRegisterTools(processId, entry.manifest, entry.capabilities);
      }
      this.registry.markHealthy(processId);
    } else {
      // Deregister tools when unhealthy
      this.toolRegistry.deregisterServiceTools(processId);
      this.registry.markUnhealthy(processId);
    }
  }

  /**
   * Called by CLI when operator approves a service.
   * Stores fingerprint, registers tools if service is currently running.
   */
  onServiceApproved(serviceId: string): void {
    const entry = this.registry.get(serviceId);
    if (!entry) {
      // Service not running - just store approval
      this.approvalStore.approve(serviceId, "");
      return;
    }

    if (!entry.manifest) {
      // No manifest yet - just approve
      this.approvalStore.approve(serviceId, "");
      this.registry.setApprovalStatus(serviceId, "approved");
      return;
    }

    // Compute and store fingerprint
    const fingerprint = computeManifestFingerprint(entry.manifest, entry.capabilities, {
      tier: entry.tier,
      url: entry.url,
    });
    this.approvalStore.approve(serviceId, fingerprint);
    this.registry.setApprovalStatus(serviceId, "approved");

    // Register tools
    this.registerTools(serviceId, entry.manifest);
  }

  /**
   * Called by CLI when operator revokes a service.
   * Immediately deregisters tools.
   */
  onServiceRevoked(serviceId: string): void {
    // Deregister tools
    this.toolRegistry.deregisterServiceTools(serviceId);

    // Update approval store
    this.approvalStore.revoke(serviceId);

    // Update registry if service is running
    const entry = this.registry.get(serviceId);
    if (entry) {
      this.registry.setApprovalStatus(serviceId, "revoked");
    }
  }

  /**
   * Shutdown: deregister all managed services.
   */
  async shutdown(): Promise<void> {
    const services = this.registry.list().filter((s) => s.tier === "managed");

    for (const service of services) {
      await this.onProcessStopped(service.id);
    }

    this.logger.info(`Shutdown: deregistered ${services.length} managed services`);
  }

  // ---------------------------------------------------------------------------
  // External Service Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Called when an external service becomes healthy.
   * - Registers the service in the registry with tier 'external'
   * - Fetches its manifest
   * - Checks approval status and conditionally registers tools
   */
  async onExternalServiceHealthy(
    id: string,
    declaration: ExternalServiceDeclaration,
  ): Promise<void> {
    // Build URL from declaration
    const host = declaration.host;
    const port = declaration.port;
    const basePath = declaration.basePath ?? "/";

    // Normalize basePath: if '/' or undefined, use just host:port with trailing slash
    // otherwise append basePath
    let url: string;
    if (basePath === "/" || basePath === undefined) {
      url = `http://${host}:${port}/`;
    } else {
      url = `http://${host}:${port}${basePath}`;
    }

    // If already registered, deregister first to allow re-registration on recovery
    if (this.registry.get(id)) {
      this.toolRegistry.deregisterServiceTools(id);
      this.registry.deregister(id);
    }

    // Register service in registry
    const entry: ServiceEntry = {
      id,
      label: declaration.label,
      tier: "external",
      url,
      healthy: true,
      capabilities: declaration.capabilities ?? [],
      expose: declaration.expose ?? "direct",
      manifest: null,
      registeredTools: [],
      approvalStatus: "pending",
    };

    this.registry.register(entry);

    // Fetch manifest
    const manifestPath = declaration.manifestPath ?? "/manifest";
    const manifest = await this.manifestFetcher.fetchAndStore(id, manifestPath);

    if (!manifest) {
      // Manifest fetch failed - log warning and return (service stays registered but no tools)
      this.logger.warn(`Failed to fetch manifest for external service "${id}"`);
      return;
    }

    // Check approval status
    await this.checkApprovalAndRegisterTools(id, manifest, entry.capabilities);
  }

  /**
   * Called when an external service becomes unhealthy.
   * - Deregisters tools for the service
   * - Marks the service as unhealthy in the registry
   */
  onExternalServiceUnhealthy(id: string): void {
    // Deregister tools
    this.toolRegistry.deregisterServiceTools(id);

    // Mark unhealthy in registry
    this.registry.markUnhealthy(id);
  }

  /**
   * Reconcile external services with the given declarations.
   * - Removes services no longer in declarations
   * - Adds new services
   * - Updates existing services if config changed
   */
  async reconcileExternalServices(declarations: ExternalServiceDeclaration[]): Promise<void> {
    // Get all external services currently in registry
    const currentExternalServices = this.registry.list().filter((s) => s.tier === "external");

    // Create a map of declarations by ID for easy lookup
    const declarationMap = new Map(declarations.map((d) => [d.id, d]));

    // Remove services no longer in declarations
    for (const service of currentExternalServices) {
      if (!declarationMap.has(service.id)) {
        // Deregister tools first
        this.toolRegistry.deregisterServiceTools(service.id);
        // Deregister from registry
        this.registry.deregister(service.id);
      }
    }

    // Process each declaration
    for (const declaration of declarations) {
      const existingEntry = this.registry.get(declaration.id);

      if (!existingEntry) {
        // New service - add it
        await this.onExternalServiceHealthy(declaration.id, declaration);
      } else {
        // Existing service - check if config changed
        const host = declaration.host;
        const port = declaration.port;
        const basePath = declaration.basePath ?? "/";
        let newUrl: string;
        if (basePath === "/" || basePath === undefined) {
          newUrl = `http://${host}:${port}/`;
        } else {
          newUrl = `http://${host}:${port}${basePath}`;
        }

        // Update registry entry if config changed
        if (
          existingEntry.label !== declaration.label ||
          existingEntry.url !== newUrl ||
          JSON.stringify(existingEntry.capabilities) !==
            JSON.stringify(declaration.capabilities ?? [])
        ) {
          // Deregister tools first
          this.toolRegistry.deregisterServiceTools(declaration.id);
          // Deregister and re-register
          this.registry.deregister(declaration.id);
          await this.onExternalServiceHealthy(declaration.id, declaration);
        }
      }
    }
  }
}
