import type { ServiceToolRegistry } from "../service-tool-registry";
import type { ServiceRegistry } from "../service-registry";

/**
 * Module-level refs for the ServiceToolRegistry and ServiceRegistry instances.
 * Set during daemon boot after service.register hook fires.
 * Consumed by the service tool context finalizer and tool executor.
 */
export const serviceToolRegistryRef: { current: ServiceToolRegistry | undefined } = {
  current: undefined,
};

export const serviceRegistryRef: { current: ServiceRegistry | undefined } = {
  current: undefined,
};

/**
 * Set both registry references at once.
 */
export function setServiceRegistryRefs(
  toolRegistry: ServiceToolRegistry,
  registry: ServiceRegistry,
): void {
  serviceToolRegistryRef.current = toolRegistry;
  serviceRegistryRef.current = registry;
}
