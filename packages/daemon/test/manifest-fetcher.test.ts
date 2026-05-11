import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ServiceRegistry, ServiceEntry } from "../src/service-registry";
import { ManifestFetcher } from "../src/manifest-fetcher";

function createMockEntry(overrides: Partial<ServiceEntry> = {}): ServiceEntry {
  return {
    id: "test-service",
    label: "Test Service",
    url: "http://127.0.0.1:3000",
    wsUrl: "ws://127.0.0.1:3000",
    healthy: true,
    capabilities: ["test-capability"],
    expose: "direct",
    manifest: null,
    registeredTools: [],
    ...overrides,
  };
}

describe("ManifestFetcher", () => {
  let registry: ServiceRegistry;
  let fetcher: ManifestFetcher;

  beforeEach(() => {
    registry = new ServiceRegistry();
    fetcher = new ManifestFetcher(registry);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("fetchManifest", () => {
    it("returns parsed manifest for valid response", async () => {
      const entry = createMockEntry({ id: "svc-1", url: "http://localhost:4000" });
      registry.register(entry);

      const validManifest = { name: "my-service", version: "1.0.0" };

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(validManifest),
        }),
      );

      const result = await fetcher.fetchManifest("svc-1");
      expect(result).toEqual(validManifest);
      expect(fetch).toHaveBeenCalledWith("http://localhost:4000/manifest");
    });

    it("returns null for non-200 response", async () => {
      const entry = createMockEntry({ id: "svc-2", url: "http://localhost:4001" });
      registry.register(entry);

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 404,
          json: () => Promise.resolve({}),
        }),
      );

      const result = await fetcher.fetchManifest("svc-2");
      expect(result).toBeNull();
    });

    it("returns null for invalid manifest (schema validation fails)", async () => {
      const entry = createMockEntry({ id: "svc-3", url: "http://localhost:4002" });
      registry.register(entry);

      const invalidManifest = { invalid: true };

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(invalidManifest),
        }),
      );

      const result = await fetcher.fetchManifest("svc-3");
      expect(result).toBeNull();
    });

    it("returns null when service is not registered", async () => {
      const result = await fetcher.fetchManifest("non-existent");
      expect(result).toBeNull();
    });

    it("uses custom manifestPath when provided", async () => {
      const entry = createMockEntry({ id: "svc-4", url: "http://localhost:4003" });
      registry.register(entry);

      const validManifest = { name: "custom-path-service", version: "2.0.0" };

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(validManifest),
        }),
      );

      const result = await fetcher.fetchManifest("svc-4", "/api/manifest.json");
      expect(result).toEqual(validManifest);
      expect(fetch).toHaveBeenCalledWith("http://localhost:4003/api/manifest.json");
    });

    it("returns null when fetch throws a network error", async () => {
      const entry = createMockEntry({ id: "svc-5", url: "http://localhost:4004" });
      registry.register(entry);

      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

      const result = await fetcher.fetchManifest("svc-5");
      expect(result).toBeNull();
    });
  });

  describe("fetchAndStore", () => {
    it("updates the registry entry's manifest field", async () => {
      const entry = createMockEntry({ id: "svc-store", url: "http://localhost:5000" });
      registry.register(entry);

      const validManifest = { name: "stored-service", version: "3.0.0" };

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(validManifest),
        }),
      );

      const result = await fetcher.fetchAndStore("svc-store");
      expect(result).toEqual(validManifest);

      const updatedEntry = registry.get("svc-store");
      expect(updatedEntry?.manifest).toEqual(validManifest);
    });

    it("sets manifest to null on fetch failure", async () => {
      const entry = createMockEntry({ id: "svc-fail", url: "http://localhost:5001" });
      registry.register(entry);

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          json: () => Promise.resolve({}),
        }),
      );

      const result = await fetcher.fetchAndStore("svc-fail");
      expect(result).toBeNull();

      const updatedEntry = registry.get("svc-fail");
      expect(updatedEntry?.manifest).toBeNull();
    });
  });
});
