import { serviceManifestSchema } from "@shoggoth/shared";
import type { ServiceManifest } from "./service-registry";
import { ServiceRegistry } from "./service-registry";

/**
 * Options for ManifestFetcher.
 */
export interface ManifestFetcherOpts {
  /** Service registry to store fetched manifests. */
  registry: ServiceRegistry;
  /** Timeout for manifest fetch in milliseconds. Default: 5000 */
  timeoutMs?: number;
  /** Logger for debugging. */
  logger?: {
    debug: (msg: string, ...args: unknown[]) => void;
    warn: (msg: string, ...args: unknown[]) => void;
  };
}

/**
 * Custom error for network failures that should trigger retry.
 */
class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkError";
  }
}

/**
 * Fetches and validates service manifests from running managed processes.
 */
export class ManifestFetcher {
  private registry: ServiceRegistry;
  private timeoutMs: number;
  private logger?: ManifestFetcherOpts["logger"];

  constructor(opts: ManifestFetcherOpts) {
    this.registry = opts.registry;
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.logger = opts.logger;
  }

  /**
   * Fetch and validate a service manifest.
   * Returns null on failure (logs warning). Caller should mark service unhealthy.
   * On success, stores the manifest on the registry entry.
   */
  async fetchAndStore(
    serviceId: string,
    manifestPath: string = "/manifest",
  ): Promise<ServiceManifest | null> {
    const entry = this.registry.get(serviceId);
    if (!entry) {
      this.logger?.warn(`Service "${serviceId}" not found in registry`);
      return null;
    }

    if (!entry.url) {
      this.logger?.warn(`Service "${serviceId}" has no URL`);
      return null;
    }

    const url = `${entry.url.replace(/\/$/, "")}${manifestPath}`;

    // First attempt - try with retry on network error
    try {
      const manifest = await this.fetchWithTimeout(url, /* retry */ true);
      if (manifest !== null) {
        return this.storeManifest(serviceId, manifest);
      }
    } catch {
      // Network error already logged and retried in fetchWithTimeout
    }

    return null;
  }

  private async fetchWithTimeout(url: string, retry: boolean): Promise<ServiceManifest | null> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        this.logger?.warn(`Manifest fetch failed for ${url}: HTTP ${response.status}`);
        return null;
      }

      let json: unknown;
      try {
        json = await response.json();
      } catch {
        this.logger?.warn(`Invalid JSON in manifest response from ${url}`);
        return null;
      }

      const result = serviceManifestSchema.safeParse(json);
      if (!result.success) {
        this.logger?.warn(`Invalid manifest schema for "${url}": ${result.error.message}`);
        return null;
      }

      return result.data;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        this.logger?.warn(`Manifest fetch timed out for ${url}`);
        return null;
      }

      // Network error
      this.logger?.warn(`Network error fetching manifest from ${url}: ${error}`);

      // Retry once if enabled
      if (retry) {
        this.logger?.debug(`Retrying manifest fetch for ${url}`);
        await this.delay(1000);
        clearTimeout(timeoutId);
        return this.fetchWithTimeout(url, false);
      }

      throw new NetworkError(error instanceof Error ? error.message : "Network error");
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private storeManifest(serviceId: string, manifest: ServiceManifest): ServiceManifest {
    // Store manifest on registry entry
    const entry = this.registry.get(serviceId);
    if (entry) {
      entry.manifest = manifest;
    }
    return manifest;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
