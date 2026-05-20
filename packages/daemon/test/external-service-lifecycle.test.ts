import { describe, it, expect, beforeEach, vi } from "vitest";
import { ServiceLifecycleManager } from "../src/service-lifecycle";
import { ServiceRegistry } from "../src/service-registry";
import { ManifestFetcher } from "../src/manifest-fetcher";
import { ServiceToolRegistry } from "../src/service-tool-registry";
import { ServiceApprovalStore } from "../src/service-approval-store";
import { computeManifestFingerprint } from "../src/manifest-fingerprint";
import type { ExternalServiceDeclaration } from "../src/external-service-health-poller";
import type { ServiceManifest } from "../src/service-registry";

/**
 * Helper to create an external service declaration.
 */
function createExternalServiceDeclaration(
  overrides: Partial<ExternalServiceDeclaration> = {},
): ExternalServiceDeclaration {
  const defaults: ExternalServiceDeclaration = {
    id: "external-service",
    label: "External Service",
    host: "127.0.0.1",
    port: 3000,
    protocol: "http",
    basePath: "/",
    capabilities: ["external-capability"],
    expose: "direct",
    manifestPath: "/manifest",
    health: { kind: "tcp", port: 3000, timeoutMs: 5000 },
    healthIntervalMs: 30000,
    unhealthyThreshold: 3,
    ...overrides,
  };
  return defaults;
}

describe("external service lifecycle", () => {
  let registry: ServiceRegistry;
  let toolRegistry: ServiceToolRegistry;
  let manifestFetcher: ManifestFetcher;
  let approvalStore: ServiceApprovalStore;
  let lifecycleManager: ServiceLifecycleManager;
  let mockFetch: ReturnType<typeof vi.fn>;
  let mockLogger: {
    debug: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    registry = new ServiceRegistry();
    toolRegistry = new ServiceToolRegistry(registry);
    mockLogger = {
      debug: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
    };

    mockFetch = vi.fn();
    // @ts-expect-error - injecting mock fetch global
    global.fetch = mockFetch;

    // Create mock DB for approval store that actually stores and returns data
    const store = new Map<
      string,
      { status: string; fingerprint: string | null; created: string; updated: string }
    >();
    const mockDb = {
      exec: vi.fn(),
      prepare: (sql: string) => {
        if (sql.includes("SELECT") && sql.includes("WHERE service_id = ?")) {
          return {
            get: (id: string) => {
              const row = store.get(id);
              if (!row) return undefined;
              return {
                service_id: id,
                status: row.status,
                approved_fingerprint: row.fingerprint,
                created_at: row.created,
                updated_at: row.updated,
              };
            },
          };
        }
        if (sql.includes("SELECT") && !sql.includes("WHERE")) {
          return {
            all: () => {
              const rows: Array<{
                service_id: string;
                status: string;
                approved_fingerprint: string | null;
                created_at: string;
                updated_at: string;
              }> = [];
              for (const [id, row] of store) {
                rows.push({
                  service_id: id,
                  status: row.status,
                  approved_fingerprint: row.fingerprint,
                  created_at: row.created,
                  updated_at: row.updated,
                });
              }
              return rows;
            },
          };
        }
        if (sql.includes("UPDATE") && sql.includes("status = 'approved'")) {
          return {
            run: (fingerprint: string, updated: string, id: string) => {
              const existing = store.get(id);
              if (existing) {
                store.set(id, { ...existing, status: "approved", fingerprint, updated });
              }
            },
          };
        }
        if (sql.includes("UPDATE") && sql.includes("status = 'revoked'")) {
          return {
            run: (updated: string, id: string) => {
              const existing = store.get(id);
              if (existing) {
                store.set(id, { ...existing, status: "revoked", fingerprint: null, updated });
              }
            },
          };
        }
        if (sql.includes("UPDATE service_approvals")) {
          return {
            run: (status: string, fingerprint: string | null, updated: string, id: string) => {
              const existing = store.get(id);
              if (existing) {
                store.set(id, { ...existing, status, fingerprint, updated });
              }
            },
          };
        }
        if (sql.includes("INSERT") && sql.includes("'approved'")) {
          return {
            run: (id: string, fingerprint: string | null, created: string, updated: string) => {
              store.set(id, { status: "approved", fingerprint, created, updated });
            },
          };
        }
        if (sql.includes("INSERT") && sql.includes("'revoked'")) {
          return {
            run: (id: string, created: string, updated: string) => {
              store.set(id, { status: "revoked", fingerprint: null, created, updated });
            },
          };
        }
        if (sql.includes("INSERT INTO service_approvals")) {
          return {
            run: (
              id: string,
              status: string,
              fingerprint: string | null,
              created: string,
              updated: string,
            ) => {
              store.set(id, { status, fingerprint, created, updated });
            },
          };
        }
        return { run: vi.fn(), get: vi.fn(() => undefined), all: vi.fn(() => []) };
      },
    } as unknown as import("better-sqlite3").Database;

    approvalStore = new ServiceApprovalStore(mockDb);

    manifestFetcher = new ManifestFetcher({
      registry,
      timeoutMs: 5000,
      logger: mockLogger,
    });

    lifecycleManager = new ServiceLifecycleManager({
      registry,
      manifestFetcher,
      toolRegistry,
      approvalStore,
      logger: mockLogger,
    });
  });

  describe("onExternalServiceHealthy", () => {
    it("should register service entry in registry with tier 'external'", async () => {
      const declaration = createExternalServiceDeclaration({ id: "ext-service" });

      await lifecycleManager.onExternalServiceHealthy("ext-service", declaration);

      const entry = registry.get("ext-service");
      expect(entry).toBeDefined();
      expect(entry?.id).toBe("ext-service");
      expect(entry?.tier).toBe("external");
      expect(entry?.label).toBe("External Service");
      expect(entry?.url).toBe("http://127.0.0.1:3000/");
    });

    it("should fetch manifest from service URL + manifestPath", async () => {
      const mockManifest: ServiceManifest = {
        name: "external-service",
        version: "1.0.0",
        tools: [
          {
            name: "external.tool",
            description: "An external tool",
            parameters: { type: "object" },
            method: "POST",
            path: "/api/external",
            dispatch: "body",
          },
        ],
        ops: ["external.op"],
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockManifest),
      });

      const declaration = createExternalServiceDeclaration({
        id: "ext-service",
        host: "192.168.1.100",
        port: 8080,
        manifestPath: "/api/manifest",
      });

      await lifecycleManager.onExternalServiceHealthy("ext-service", declaration);

      // Verify fetch was called with correct URL
      expect(mockFetch).toHaveBeenCalledWith(
        "http://192.168.1.100:8080/api/manifest",
        expect.objectContaining({
          method: "GET",
        }),
      );
    });

    it("should create pending request and NOT register tools when no prior approval", async () => {
      const mockManifest: ServiceManifest = {
        name: "external-service",
        version: "1.0.0",
        tools: [
          {
            name: "external.tool",
            description: "An external tool",
            parameters: { type: "object" },
            method: "POST",
            path: "/api/external",
            dispatch: "body",
          },
        ],
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockManifest),
      });

      const declaration = createExternalServiceDeclaration({ id: "ext-service" });

      await lifecycleManager.onExternalServiceHealthy("ext-service", declaration);

      const entry = registry.get("ext-service");
      expect(entry?.approvalStatus).toBe("pending");
      expect(entry?.registeredTools).toEqual([]);
      expect(toolRegistry.get("external.tool")).toBeUndefined();
    });

    it("should register tools from manifest when approved and fingerprint matches", async () => {
      const mockManifest: ServiceManifest = {
        name: "external-service",
        version: "1.0.0",
        tools: [
          {
            name: "external.tool",
            description: "An external tool",
            parameters: { type: "object" },
            method: "POST",
            path: "/api/external",
            dispatch: "body",
          },
        ],
      };

      // Pre-approve the service with the CORRECT fingerprint
      const fingerprint = computeManifestFingerprint(mockManifest, ["external-capability"]);
      approvalStore.approve("ext-service", fingerprint);

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockManifest),
      });

      const declaration = createExternalServiceDeclaration({
        id: "ext-service",
        capabilities: ["external-capability"],
      });

      await lifecycleManager.onExternalServiceHealthy("ext-service", declaration);

      const entry = registry.get("ext-service");
      expect(entry?.approvalStatus).toBe("approved");
      expect(entry?.registeredTools).toContain("external.tool");
      expect(toolRegistry.get("external.tool")).toBeDefined();
    });

    it("should mark pending-reapproval and remove tools when approved but fingerprint changed", async () => {
      const mockManifest: ServiceManifest = {
        name: "external-service",
        version: "1.0.0",
        tools: [
          {
            name: "external.tool",
            description: "An external tool",
            parameters: { type: "object" },
            method: "POST",
            path: "/api/external",
            dispatch: "body",
          },
        ],
      };

      // Pre-approve with a different fingerprint
      approvalStore.approve("ext-service", "old-fingerprint");

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockManifest),
      });

      const declaration = createExternalServiceDeclaration({ id: "ext-service" });

      await lifecycleManager.onExternalServiceHealthy("ext-service", declaration);

      const entry = registry.get("ext-service");
      expect(entry?.approvalStatus).toBe("pending-reapproval");
      // Tools should NOT be registered when fingerprint doesn't match
      expect(entry?.registeredTools).toEqual([]);
      expect(toolRegistry.get("external.tool")).toBeUndefined();
    });

    it("should NOT register tools when service is revoked", async () => {
      const mockManifest: ServiceManifest = {
        name: "external-service",
        version: "1.0.0",
        tools: [
          {
            name: "external.tool",
            description: "An external tool",
            parameters: { type: "object" },
            method: "POST",
            path: "/api/external",
            dispatch: "body",
          },
        ],
      };

      // Revoke the service
      approvalStore.revoke("ext-service");

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockManifest),
      });

      const declaration = createExternalServiceDeclaration({ id: "ext-service" });

      await lifecycleManager.onExternalServiceHealthy("ext-service", declaration);

      const entry = registry.get("ext-service");
      expect(entry?.approvalStatus).toBe("revoked");
      expect(entry?.registeredTools).toEqual([]);
      expect(toolRegistry.get("external.tool")).toBeUndefined();
    });

    it("should log warning when manifest fetch fails but service still registered", async () => {
      mockFetch.mockRejectedValue(new Error("Network error"));

      const declaration = createExternalServiceDeclaration({ id: "ext-service" });

      await lifecycleManager.onExternalServiceHealthy("ext-service", declaration);

      // Service should still be registered even though manifest fetch failed
      const entry = registry.get("ext-service");
      expect(entry).toBeDefined();
      expect(entry?.tier).toBe("external");
      expect(entry?.manifest).toBeNull();
      // Warning should be logged
      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });

  describe("onExternalServiceUnhealthy", () => {
    it("should deregister tools for the service", async () => {
      const mockManifest: ServiceManifest = {
        name: "external-service",
        version: "1.0.0",
        tools: [
          {
            name: "external.tool",
            description: "An external tool",
            parameters: { type: "object" },
            method: "POST",
            path: "/api/external",
            dispatch: "body",
          },
        ],
      };

      // First, make the service healthy and approved
      const fingerprint = computeManifestFingerprint(mockManifest, ["external-capability"]);
      approvalStore.approve("ext-service", fingerprint);

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockManifest),
      });

      const declaration = createExternalServiceDeclaration({ id: "ext-service" });
      await lifecycleManager.onExternalServiceHealthy("ext-service", declaration);

      expect(toolRegistry.get("external.tool")).toBeDefined();

      // Now mark as unhealthy
      await lifecycleManager.onExternalServiceUnhealthy("ext-service");

      // Tools should be deregistered
      expect(toolRegistry.get("external.tool")).toBeUndefined();
    });

    it("should mark service unhealthy in registry", async () => {
      const declaration = createExternalServiceDeclaration({ id: "ext-service" });

      // First make it healthy
      await lifecycleManager.onExternalServiceHealthy("ext-service", declaration);

      expect(registry.get("ext-service")?.healthy).toBe(true);

      // Now mark as unhealthy
      await lifecycleManager.onExternalServiceUnhealthy("ext-service");

      expect(registry.get("ext-service")?.healthy).toBe(false);
    });
  });

  describe("reconcileExternalServices", () => {
    it("should remove services no longer in config - stop poller, deregister tools, deregister from registry", async () => {
      const mockManifest: ServiceManifest = {
        name: "external-service",
        version: "1.0.0",
        tools: [
          {
            name: "external.tool",
            description: "An external tool",
            parameters: { type: "object" },
            method: "POST",
            path: "/api/external",
            dispatch: "body",
          },
        ],
      };

      // Pre-approve and have a running service
      const fingerprint = computeManifestFingerprint(mockManifest, ["external-capability"]);
      approvalStore.approve("removed-service", fingerprint);

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockManifest),
      });

      // Add service to registry first
      const removedDeclaration = createExternalServiceDeclaration({
        id: "removed-service",
        label: "Removed Service",
      });
      await lifecycleManager.onExternalServiceHealthy("removed-service", removedDeclaration);

      expect(registry.get("removed-service")).toBeDefined();
      expect(toolRegistry.get("external.tool")).toBeDefined();

      // Now reconcile with only "kept-service" in config
      const keptDeclaration = createExternalServiceDeclaration({
        id: "kept-service",
        label: "Kept Service",
      });

      await lifecycleManager.reconcileExternalServices([keptDeclaration]);

      // removed-service should be deregistered
      expect(registry.get("removed-service")).toBeUndefined();
      // Tools for removed-service should be deregistered
      expect(toolRegistry.get("external.tool")).toBeUndefined();
    });

    it("should add new services - start poller", async () => {
      const mockManifest: ServiceManifest = {
        name: "new-service",
        version: "1.0.0",
        tools: [
          {
            name: "new.tool",
            description: "A new tool",
            parameters: { type: "object" },
            method: "POST",
            path: "/api/new",
            dispatch: "body",
          },
        ],
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockManifest),
      });

      // Reconcile with a new service
      const newDeclaration = createExternalServiceDeclaration({
        id: "new-service",
        label: "New Service",
      });

      await lifecycleManager.reconcileExternalServices([newDeclaration]);

      // New service should be registered
      const entry = registry.get("new-service");
      expect(entry).toBeDefined();
      expect(entry?.tier).toBe("external");
    });

    it("should update existing services - restart poller with new config", async () => {
      const mockManifest: ServiceManifest = {
        name: "updated-service",
        version: "1.0.0",
        tools: [
          {
            name: "updated.tool",
            description: "An updated tool",
            parameters: { type: "object" },
            method: "POST",
            path: "/api/updated",
            dispatch: "body",
          },
        ],
      };

      // First add the service
      const originalDeclaration = createExternalServiceDeclaration({
        id: "updated-service",
        label: "Original Label",
        port: 3000,
      });

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockManifest),
      });

      await lifecycleManager.onExternalServiceHealthy("updated-service", originalDeclaration);

      expect(registry.get("updated-service")?.label).toBe("Original Label");
      expect(registry.get("updated-service")?.url).toBe("http://127.0.0.1:3000/");

      // Now reconcile with updated config
      const updatedDeclaration = createExternalServiceDeclaration({
        id: "updated-service",
        label: "Updated Label",
        port: 4000,
        host: "192.168.1.50",
      });

      await lifecycleManager.reconcileExternalServices([updatedDeclaration]);

      // Service should have updated config
      const entry = registry.get("updated-service");
      expect(entry?.label).toBe("Updated Label");
      expect(entry?.url).toBe("http://192.168.1.50:4000/");
    });

    it("should handle empty config - remove all external services", async () => {
      const mockManifest: ServiceManifest = {
        name: "external-service",
        version: "1.0.0",
        tools: [
          {
            name: "external.tool",
            description: "An external tool",
            parameters: { type: "object" },
            method: "POST",
            path: "/api/external",
            dispatch: "body",
          },
        ],
      };

      // Pre-approve
      const fingerprint = computeManifestFingerprint(mockManifest, ["external-capability"]);
      approvalStore.approve("some-service", fingerprint);

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockManifest),
      });

      // Add a service
      const declaration = createExternalServiceDeclaration({ id: "some-service" });
      await lifecycleManager.onExternalServiceHealthy("some-service", declaration);

      expect(registry.get("some-service")).toBeDefined();

      // Reconcile with empty config
      await lifecycleManager.reconcileExternalServices([]);

      // All external services should be removed
      const externalServices = registry.list().filter((s) => s.tier === "external");
      expect(externalServices).toEqual([]);
    });
  });
});
