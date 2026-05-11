import type { ProcessDeclaration, ExternalServiceDeclaration } from "@shoggoth/shared";
import type { ServiceRegistry, ServiceEntry } from "./service-registry";
import type { ManifestFetcher } from "./manifest-fetcher";
import type { ServiceToolRegistry } from "./service-tool-registry";
import type { HealthChecker } from "./health-checker";

export interface ServiceLifecycleManagerOpts {
  registry: ServiceRegistry;
  manifestFetcher: ManifestFetcher;
  toolRegistry: ServiceToolRegistry;
  healthChecker: HealthChecker;
}

/**
 * Manages the lifecycle of services tied to procman processes and external declarations.
 * Bridges process start/stop/health events to the service registry, manifest fetcher,
 * and tool registry.
 */
export class ServiceLifecycleManager {
  private registry: ServiceRegistry;
  private manifestFetcher: ManifestFetcher;
  private toolRegistry: ServiceToolRegistry;
  private healthChecker: HealthChecker;

  /** Track which service IDs we manage for shutdown cleanup. */
  private managedServices = new Set<string>();

  constructor(opts: ServiceLifecycleManagerOpts) {
    this.registry = opts.registry;
    this.manifestFetcher = opts.manifestFetcher;
    this.toolRegistry = opts.toolRegistry;
    this.healthChecker = opts.healthChecker;
  }

  /**
   * Called when a process starts. If the process declares a service,
   * registers it, fetches its manifest, and registers any tools.
   */
  async onProcessStarted(processId: string, declaration: ProcessDeclaration): Promise<void> {
    if (!declaration.service) {
      return;
    }

    const svc = declaration.service;
    const baseUrl = `http://${svc.host}:${svc.port}${svc.basePath === "/" ? "" : svc.basePath}`;

    const entry: ServiceEntry = {
      id: processId,
      label: declaration.label,
      url: baseUrl,
      wsUrl:
        svc.protocol === "ws" || svc.protocol === "http+ws"
          ? `ws://${svc.host}:${svc.port}${svc.basePath === "/" ? "" : svc.basePath}`
          : undefined,
      healthy: true,
      capabilities: svc.capabilities ?? [],
      expose: svc.expose,
      manifest: null,
      registeredTools: [],
    };

    this.registry.register(entry);
    this.managedServices.add(processId);

    const manifest = await this.manifestFetcher.fetchAndStore(processId, svc.manifestPath);

    if (manifest?.tools && manifest.tools.length > 0) {
      this.toolRegistry.registerServiceTools(processId, manifest);
    }
  }

  /**
   * Called when a process stops. Deregisters tools and the service entry.
   */
  async onProcessStopped(processId: string): Promise<void> {
    this.toolRegistry.deregisterServiceTools(processId);
    this.registry.deregister(processId);
    this.managedServices.delete(processId);
  }

  /**
   * Called when a process health status changes.
   */
  onProcessHealthChanged(processId: string, healthy: boolean): void {
    if (healthy) {
      this.registry.markHealthy(processId);
    } else {
      this.registry.markUnhealthy(processId);
    }
  }

  /**
   * Register external services (not managed by procman).
   * Registers each service, starts health polling, fetches manifest, and registers tools.
   */
  async registerExternalServices(services: ExternalServiceDeclaration[]): Promise<void> {
    for (const svc of services) {
      const baseUrl = `http://${svc.host}:${svc.port}${svc.basePath === "/" ? "" : svc.basePath}`;

      const entry: ServiceEntry = {
        id: svc.id,
        label: svc.label,
        url: baseUrl,
        wsUrl:
          svc.protocol === "ws" || svc.protocol === "http+ws"
            ? `ws://${svc.host}:${svc.port}${svc.basePath === "/" ? "" : svc.basePath}`
            : undefined,
        healthy: false,
        capabilities: svc.capabilities ?? [],
        expose: svc.expose,
        manifest: null,
        registeredTools: [],
      };

      this.registry.register(entry);
      this.managedServices.add(svc.id);

      this.healthChecker.startPolling(svc.id, svc.health, svc.healthIntervalMs);

      const manifest = await this.manifestFetcher.fetchAndStore(svc.id, svc.manifestPath);

      if (manifest?.tools && manifest.tools.length > 0) {
        this.toolRegistry.registerServiceTools(svc.id, manifest);
      }
    }
  }

  /**
   * Shutdown: stop all health polling and deregister all managed services.
   */
  async shutdown(): Promise<void> {
    this.healthChecker.stopAll();

    for (const serviceId of this.managedServices) {
      this.toolRegistry.deregisterServiceTools(serviceId);
      this.registry.deregister(serviceId);
    }

    this.managedServices.clear();
  }
}
