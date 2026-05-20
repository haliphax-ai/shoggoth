import { describe, it, expect, beforeEach, vi } from "vitest";
import { ManifestFetcher } from "../src/manifest-fetcher";
import { ServiceRegistry, ServiceEntry } from "../src/service-registry";

/**
 * Helper function to create a mock ServiceEntry for testing.
 */
function createMockEntry(overrides: Partial<ServiceEntry> = {}): ServiceEntry {
  return {
    id: "test-service",
    label: "Test Service",
    tier: "managed",
    url: "http://127.0.0.1:3000",
    wsUrl: "ws://127.0.0.1:3000",
    healthy: true,
    capabilities: ["test-capability"],
    expose: "direct",
    manifest: null,
    registeredTools: [],
    approvalStatus: "pending",
    ...overrides,
  };
}

describe("ManifestFetcher", () => {
  let registry: ServiceRegistry;
  let fetcher: ManifestFetcher;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    registry = new ServiceRegistry();
    mockFetch = vi.fn();
    // @ts-expect-error - injecting mock fetch global
    global.fetch = mockFetch;
    fetcher = new ManifestFetcher({
      registry,
      timeoutMs: 5000,
      logger: {
        debug: vi.fn(),
        warn: vi.fn(),
      },
    });
  });

  describe("fetchAndStore", () => {
    it("should fetch manifest successfully and store on registry", async () => {
      // Note: schema adds default dispatch: "body" so we include it here
      const mockManifest = {
        name: "test-service",
        version: "1.0.0",
        tools: [
          {
            name: "test.tool",
            description: "A test tool",
            parameters: { type: "object" },
            method: "POST",
            path: "/api/test",
            dispatch: "body",
          },
        ],
        ops: ["test.op"],
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockManifest),
      });

      registry.register(createMockEntry({ id: "test-service" }));

      const result = await fetcher.fetchAndStore("test-service", "/manifest");

      expect(result).toEqual(mockManifest);
      const entry = registry.get("test-service");
      expect(entry?.manifest).toEqual(mockManifest);
    });

    it("should return null on 404 response", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
      });

      registry.register(createMockEntry({ id: "test-service" }));

      const result = await fetcher.fetchAndStore("test-service");

      expect(result).toBeNull();
    });

    it("should return null on invalid JSON response", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.reject(new Error("Invalid JSON")),
      });

      registry.register(createMockEntry({ id: "test-service" }));

      const result = await fetcher.fetchAndStore("test-service");

      expect(result).toBeNull();
    });

    it("should return null on invalid manifest schema", async () => {
      // Missing required fields (name, version)
      const invalidManifest = {
        tools: [{ name: "test.tool" }],
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(invalidManifest),
      });

      registry.register(createMockEntry({ id: "test-service" }));

      const result = await fetcher.fetchAndStore("test-service");

      expect(result).toBeNull();
    });

    it("should return null on network error", async () => {
      mockFetch.mockRejectedValue(new Error("Network error"));

      registry.register(createMockEntry({ id: "test-service" }));

      const result = await fetcher.fetchAndStore("test-service");

      expect(result).toBeNull();
    });

    it("should retry on network error and succeed on second attempt", async () => {
      const mockManifest = {
        name: "test-service",
        version: "1.0.0",
      };

      mockFetch.mockRejectedValueOnce(new Error("Network error")).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockManifest),
      });

      registry.register(createMockEntry({ id: "test-service" }));

      const result = await fetcher.fetchAndStore("test-service");

      expect(result).toEqual(mockManifest);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("should return null if service is not registered", async () => {
      const result = await fetcher.fetchAndStore("nonexistent");

      expect(result).toBeNull();
    });

    it("should use custom manifest path", async () => {
      const mockManifest = {
        name: "test-service",
        version: "1.0.0",
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockManifest),
      });

      registry.register(createMockEntry({ id: "test-service", url: "http://127.0.0.1:3000" }));

      await fetcher.fetchAndStore("test-service", "/api/manifest");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://127.0.0.1:3000/api/manifest",
        expect.objectContaining({ method: "GET" }),
      );
    });

    it("should respect timeout", async () => {
      const slowFetcher = new ManifestFetcher({
        registry,
        timeoutMs: 100,
        logger: { debug: vi.fn(), warn: vi.fn() },
      });

      // Create a fetch that respects AbortController signal
      mockFetch.mockImplementation((_url: string, options?: { signal?: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new DOMException("Aborted", "AbortError"));
          }, 10000);
          options?.signal?.addEventListener("abort", () => {
            clearTimeout(timeout);
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      });

      registry.register(createMockEntry({ id: "test-service" }));

      const result = await slowFetcher.fetchAndStore("test-service");

      expect(result).toBeNull();
    });
  });
});
