import type { ShoggothConfig } from "@shoggoth/shared";
import { ServiceRegistry, type ServiceEntry } from "./service-registry";
import { ServiceToolRegistry } from "./service-tool-registry";
import type { ShoggothPluginSystem } from "@shoggoth/plugins";
import type { PluginServiceEntry, DirectServiceTool } from "@shoggoth/plugins";

/**
 * Create a new ServiceRegistry instance.
 */
export function createServiceRegistry(): ServiceRegistry {
  return new ServiceRegistry();
}

/**
 * Create a new ServiceToolRegistry instance.
 */
export function createServiceToolRegistry(registry: ServiceRegistry): ServiceToolRegistry {
  return new ServiceToolRegistry(registry);
}

/**
 * Fire the service.register hook to allow plugin services to register themselves.
 * This should be called after plugins are loaded but before daemon.ready fires.
 *
 * @param system - The plugin system
 * @param registry - The service registry
 * @param toolRegistry - The service tool registry
 * @param config - The resolved config (after daemon.configure waterfall)
 */
export async function fireServiceRegisterHook(
  system: ShoggothPluginSystem,
  registry: ServiceRegistry,
  toolRegistry: ServiceToolRegistry,
  config: ShoggothConfig,
): Promise<void> {
  let lastRegisteredServiceId: string | undefined;

  const ctx = {
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
        registeredTools: [],
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
  };

  // Fire the async hook - plugins can implement this as async
  await system.lifecycle["service.register"].emit(ctx);
}
