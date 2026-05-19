import { describe, it, expect, beforeEach, vi } from "vitest";
import { ServiceLifecycleManager } from "../src/service-lifecycle";
import { ServiceRegistry } from "../src/service-registry";
import { ManifestFetcher } from "../src/manifest-fetcher";
import { ServiceToolRegistry } from "../src/service-tool-registry";
import { ServiceApprovalStore } from "../src/service-approval-store";
import { computeManifestFingerprint } from "../src/manifest-fingerprint";
import type { ProcessDeclaration } from "@shoggoth/shared";
import type { ServiceManifest } from "../src/service-registry";

/**
 * Helper to create a process declaration with service block.
 */
function createProcessDeclaration(overrides: Partial<ProcessDeclaration> = {}): ProcessDeclaration {
  const defaults: ProcessDeclaration = {
    id: "test-service",
    label: "Test Service",
    startPolicy: "boot",
    command: "node",
    args: ["server.js"],
    service: {
      port: 3000,
      protocol: "http",
      basePath: "/",
      capabilities: ["test-capability"],
      expose: "direct",
      manifestPath: "/manifest",
      host: "127.0.0.1",
    },
    ...overrides,
  };
  return defaults;
}

/**
 * Helper to create a process declaration WITHOUT service block.
 */
function createProcessDeclarationNoService(
  overrides: Partial<ProcessDeclaration> = {},
): ProcessDeclaration {
  return {
    id: "test-service",
    label: "Test Service",
    startPolicy: "boot",
    command: "node",
    args: ["server.js"],
    ...overrides,
  };
}

describe("ServiceLifecycleManager", () => {
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
    toolRegistry = new ServiceToolRegistry({ serviceRegistry: registry });
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

  describe("onProcessStarted", () => {
    it("should NOT register service when process has no service block", async () => {
      const processDecl = createProcessDeclarationNoService();

      await lifecycleManager.onProcessStarted("test-service", processDecl);

      const entry = registry.get("test-service");
      expect(entry).toBeUndefined();
    });

    it("should register service when process has service block", async () => {
      const processDecl = createProcessDeclaration();

      await lifecycleManager.onProcessStarted("test-service", processDecl);

      const entry = registry.get("test-service");
      expect(entry).toBeDefined();
      expect(entry?.id).toBe("test-service");
      expect(entry?.tier).toBe("managed");
      expect(entry?.url).toBe("http://127.0.0.1:3000");
      expect(entry?.capabilities).toEqual(["test-capability"]);
    });

    it("should fetch manifest and set pending status when manifest fetch succeeds", async () => {
      const mockManifest: ServiceManifest = {
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

      const processDecl = createProcessDeclaration();

      await lifecycleManager.onProcessStarted("test-service", processDecl);

      const entry = registry.get("test-service");
      expect(entry?.manifest).toEqual(mockManifest);
      expect(entry?.approvalStatus).toBe("pending");
    });

    it("should set approval status to pending when manifest fetch fails", async () => {
      mockFetch.mockRejectedValue(new Error("Network error"));

      const processDecl = createProcessDeclaration();

      await lifecycleManager.onProcessStarted("test-service", processDecl);

      const entry = registry.get("test-service");
      expect(entry?.manifest).toBeNull();
      expect(entry?.approvalStatus).toBe("pending");
    });

    it("should register tools when service is already approved with matching fingerprint", async () => {
      const mockManifest: ServiceManifest = {
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
      };

      // Pre-approve the service with the CORRECT fingerprint computed from the manifest
      const fingerprint = computeManifestFingerprint(mockManifest, []);
      approvalStore.approve("test-service", fingerprint);

      // Return the manifest when fetching
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockManifest),
      });

      const processDecl = createProcessDeclaration({
        id: "test-service",
        service: {
          port: 3000,
          protocol: "http",
          capabilities: [],
          expose: "direct",
        },
      });

      await lifecycleManager.onProcessStarted("test-service", processDecl);

      const entry = registry.get("test-service");
      expect(entry?.approvalStatus).toBe("approved");
      expect(entry?.registeredTools).toContain("test.tool");
    });

    it("should set pending-reapproval when fingerprint doesn't match", async () => {
      const mockManifest: ServiceManifest = {
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
      };

      // Pre-approve with a different fingerprint
      approvalStore.approve("test-service", "old-fingerprint");

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockManifest),
      });

      const processDecl = createProcessDeclaration({
        id: "test-service",
        service: {
          port: 3000,
          protocol: "http",
          capabilities: [],
          expose: "direct",
        },
      });

      await lifecycleManager.onProcessStarted("test-service", processDecl);

      const entry = registry.get("test-service");
      expect(entry?.approvalStatus).toBe("pending-reapproval");
      // Tools should NOT be registered when fingerprint doesn't match
      expect(entry?.registeredTools).toEqual([]);
    });

    it("should not register tools when service is revoked", async () => {
      const mockManifest: ServiceManifest = {
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
      };

      // Revoke the service
      approvalStore.revoke("test-service");

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockManifest),
      });

      const processDecl = createProcessDeclaration({
        id: "test-service",
        service: {
          port: 3000,
          protocol: "http",
          capabilities: [],
          expose: "direct",
        },
      });

      await lifecycleManager.onProcessStarted("test-service", processDecl);

      const entry = registry.get("test-service");
      expect(entry?.approvalStatus).toBe("revoked");
      expect(entry?.registeredTools).toEqual([]);
    });
  });

  describe("onProcessStopped", () => {
    it("should deregister tools and service when process stops", async () => {
      const mockManifest: ServiceManifest = {
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
      };

      // First, start the process
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockManifest),
      });

      const processDecl = createProcessDeclaration();
      await lifecycleManager.onProcessStarted("test-service", processDecl);

      // Approve and register tools using the correct fingerprint
      const fingerprint = computeManifestFingerprint(mockManifest, []);
      approvalStore.approve("test-service", fingerprint);
      const entry = registry.get("test-service");
      if (entry?.manifest) {
        toolRegistry.registerServiceTools("test-service", entry.manifest);
      }

      expect(registry.get("test-service")).toBeDefined();
      expect(toolRegistry.get("test.tool")).toBeDefined();

      // Now stop the process
      await lifecycleManager.onProcessStopped("test-service");

      expect(registry.get("test-service")).toBeUndefined();
      expect(toolRegistry.get("test.tool")).toBeUndefined();
    });

    it("should handle stopping a process that was never started", async () => {
      // Should not throw
      await lifecycleManager.onProcessStopped("nonexistent");
      expect(registry.get("nonexistent")).toBeUndefined();
    });
  });

  describe("onProcessHealthChanged", () => {
    it("should deregister tools when process becomes unhealthy", async () => {
      const mockManifest: ServiceManifest = {
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
      };

      // Start and approve the service
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockManifest),
      });

      const processDecl = createProcessDeclaration();
      await lifecycleManager.onProcessStarted("test-service", processDecl);

      // Approve with correct fingerprint
      const fingerprint = computeManifestFingerprint(mockManifest, ["test-capability"]);
      approvalStore.approve("test-service", fingerprint);

      const entry = registry.get("test-service");
      if (entry?.manifest) {
        toolRegistry.registerServiceTools("test-service", entry.manifest);
      }

      expect(toolRegistry.get("test.tool")).toBeDefined();

      // Mark as unhealthy
      await lifecycleManager.onProcessHealthChanged("test-service", false);

      // Tools should be removed
      expect(toolRegistry.get("test.tool")).toBeUndefined();
      // But service should still be registered
      expect(registry.get("test-service")).toBeDefined();
    });

    it("should re-check approval and conditionally register tools when process becomes healthy", async () => {
      const mockManifest: ServiceManifest = {
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
      };

      // Start process but don't approve
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockManifest),
      });

      const processDecl = createProcessDeclaration();
      await lifecycleManager.onProcessStarted("test-service", processDecl);

      // Mark as unhealthy (tools shouldn't be there anyway)
      await lifecycleManager.onProcessHealthChanged("test-service", false);

      // Now approve with correct fingerprint
      const fingerprint = computeManifestFingerprint(mockManifest, ["test-capability"]);
      approvalStore.approve("test-service", fingerprint);

      // Mark as healthy again - should re-check approval
      await lifecycleManager.onProcessHealthChanged("test-service", true);

      // Tools should now be registered
      const entry = registry.get("test-service");
      expect(entry?.registeredTools).toContain("test.tool");
    });
  });

  describe("onServiceApproved", () => {
    it("should register tools when approving an already running service", async () => {
      const mockManifest: ServiceManifest = {
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
      };

      // Start and fetch manifest
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockManifest),
      });

      const processDecl = createProcessDeclaration();
      await lifecycleManager.onProcessStarted("test-service", processDecl);

      // Approve via the lifecycle manager
      lifecycleManager.onServiceApproved("test-service");

      const entry = registry.get("test-service");
      expect(entry?.approvalStatus).toBe("approved");
      expect(entry?.registeredTools).toContain("test.tool");
    });

    it("should handle approving a non-existent service", () => {
      // Should not throw
      expect(() => lifecycleManager.onServiceApproved("nonexistent")).not.toThrow();
    });
  });

  describe("onServiceRevoked", () => {
    it("should deregister tools when revoking a service", async () => {
      const mockManifest: ServiceManifest = {
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
      };

      // Start and approve
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockManifest),
      });

      const processDecl = createProcessDeclaration();
      await lifecycleManager.onProcessStarted("test-service", processDecl);

      // Approve with correct fingerprint
      const fingerprint = computeManifestFingerprint(mockManifest, ["test-capability"]);
      approvalStore.approve("test-service", fingerprint);

      const entry = registry.get("test-service");
      if (entry?.manifest) {
        toolRegistry.registerServiceTools("test-service", entry.manifest);
      }

      expect(toolRegistry.get("test.tool")).toBeDefined();

      // Revoke via the lifecycle manager
      lifecycleManager.onServiceRevoked("test-service");

      expect(registry.get("test-service")?.approvalStatus).toBe("revoked");
      expect(toolRegistry.get("test.tool")).toBeUndefined();
    });

    it("should handle revoking a non-existent service", () => {
      // Should not throw
      expect(() => lifecycleManager.onServiceRevoked("nonexistent")).not.toThrow();
    });
  });

  describe("shutdown", () => {
    it("should deregister all managed services on shutdown", async () => {
      const mockManifest: ServiceManifest = {
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
      };

      // Start two services
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockManifest),
      });

      const processDecl1 = createProcessDeclaration({ id: "service-1" });
      const processDecl2 = createProcessDeclaration({ id: "service-2" });

      await lifecycleManager.onProcessStarted("service-1", processDecl1);
      await lifecycleManager.onProcessStarted("service-2", processDecl2);

      expect(registry.get("service-1")).toBeDefined();
      expect(registry.get("service-2")).toBeDefined();

      // Shutdown
      await lifecycleManager.shutdown();

      expect(registry.list()).toEqual([]);
    });
  });
});
