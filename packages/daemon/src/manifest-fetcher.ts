import { serviceManifestSchema, type ServiceManifest } from "@shoggoth/shared";
import type { ServiceRegistry } from "./service-registry";

/**
 * Fetches and validates service manifests from registered services.
 */
export class ManifestFetcher {
  private registry: ServiceRegistry;

  constructor(registry: ServiceRegistry) {
    this.registry = registry;
  }

  /**
   * Fetch and validate a manifest from a service.
   * @param serviceId - The registered service ID
   * @param manifestPath - Optional path override (defaults to '/manifest')
   * @returns Parsed ServiceManifest or null on failure
   */
  async fetchManifest(serviceId: string, manifestPath?: string): Promise<ServiceManifest | null> {
    const entry = this.registry.get(serviceId);
    if (!entry) {
      return null;
    }

    const url = `${entry.url}${manifestPath || "/manifest"}`;

    let response: Response;
    try {
      response = await fetch(url);
    } catch {
      return null;
    }

    if (!response.ok) {
      return null;
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return null;
    }

    const result = serviceManifestSchema.safeParse(json);
    if (!result.success) {
      return null;
    }

    return result.data;
  }

  /**
   * Fetch a manifest and store it on the service registry entry.
   * @param serviceId - The registered service ID
   * @param manifestPath - Optional path override (defaults to '/manifest')
   * @returns Parsed ServiceManifest or null on failure
   */
  async fetchAndStore(serviceId: string, manifestPath?: string): Promise<ServiceManifest | null> {
    const manifest = await this.fetchManifest(serviceId, manifestPath);

    const entry = this.registry.get(serviceId);
    if (entry) {
      entry.manifest = manifest;
    }

    return manifest;
  }
}
