import type { ServiceToolRegistry } from "../service-tool-registry";

/**
 * Module-level ref for the ServiceToolRegistry instance.
 * Set during daemon boot after service.register hook fires.
 * Consumed by the service tool context finalizer and tool executor.
 */
export const serviceToolRegistryRef: { current: ServiceToolRegistry | undefined } = {
  current: undefined,
};
