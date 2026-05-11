import { describe, it, expect, beforeEach, vi } from "vitest";
import { ServiceLifecycleManager } from "../src/service-lifecycle";
import type { ServiceRegistry } from "../src/service-registry";
import type { ManifestFetcher } from "../src/manifest-fetcher";
import type { ServiceToolRegistry } from "../src/service-tool-registry";
import type { HealthChecker } from "../src/health-checker";
import type { ProcessDeclaration, ServiceManifest } from "@shoggoth/shared";

function createMockRegistry() {
  return {
    register: vi.fn(),
    deregister: vi.fn(),
    markHealthy: vi.fn(),
    markUnhealthy: vi.fn(),
    get: vi.fn(),
    list: vi.fn(() => []),
  } as unknown as ServiceRegistry & {
    register: ReturnType<typeof vi.fn>;
    deregister: ReturnType<typeof vi.fn>;
    markHealthy: ReturnType<typeof vi.fn>;
    markUnhealthy: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
  };
}

function createMockManifestFetcher() {
  return {
    fetchAndStore: vi.fn().mockResolvedValue(null),
    fetchManifest: vi.fn().mockResolvedValue(null),
  } as unknown as ManifestFetcher & {
    fetchAndStore: ReturnType<typeof vi.fn>;
    fetchManifest: ReturnType<typeof vi.fn>;
  };
}

function createMockToolRegistry() {
  return {
    registerServiceTools: vi.fn().mockReturnValue([]),
    deregisterServiceTools: vi.fn(),
    listTools: vi.fn().mockReturnValue([]),
  } as unknown as ServiceToolRegistry & {
    registerServiceTools: ReturnType<typeof vi.fn>;
    deregisterServiceTools: ReturnType<typeof vi.fn>;
    listTools: ReturnType<typeof vi.fn>;
  };
}

function createMockHealthChecker() {
  return {
    startPolling: vi.fn(),
    stopPolling: vi.fn(),
    stopAll: vi.fn(),
    checkOnce: vi.fn().mockResolvedValue(true),
  } as unknown as HealthChecker & {
    startPolling: ReturnType<typeof vi.fn>;
    stopPolling: ReturnType<typeof vi.fn>;
    stopAll: ReturnType<typeof vi.fn>;
    checkOnce: ReturnType<typeof vi.fn>;
  };
}

function createProcessDeclaration(overrides: Partial<ProcessDeclaration> = {}): ProcessDeclaration {
  return {
    id: "proc-1",
    command: "node",
    args: ["server.js"],
    startPolicy: "boot",
    ...overrides,
  };
}

describe("ServiceLifecycleManager", () => {
  let registry: ReturnType<typeof createMockRegistry>;
  let manifestFetcher: ReturnType<typeof createMockManifestFetcher>;
  let toolRegistry: ReturnType<typeof createMockToolRegistry>;
  let healthChecker: ReturnType<typeof createMockHealthChecker>;
  let manager: ServiceLifecycleManager;

  beforeEach(() => {
    registry = createMockRegistry();
    manifestFetcher = createMockManifestFetcher();
    toolRegistry = createMockToolRegistry();
    healthChecker = createMockHealthChecker();
    manager = new ServiceLifecycleManager({
      registry,
      manifestFetcher,
      toolRegistry,
      healthChecker,
    });
  });

  describe("onProcessStarted", () => {
    it("registers service with correct URL from host and port", async () => {
      const decl = createProcessDeclaration({
        id: "my-svc",
        label: "My Service",
        service: {
          port: 3000,
          protocol: "http",
          basePath: "/",
          host: "127.0.0.1",
          capabilities: ["search"],
          expose: "direct",
          manifestPath: "/manifest",
        },
      });

      await manager.onProcessStarted("my-svc", decl);

      expect(registry.register).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "my-svc",
          url: "http://127.0.0.1:3000",
          healthy: true,
          capabilities: ["search"],
          expose: "direct",
        }),
      );
    });

    it("fetches manifest and registers tools when manifest has tools", async () => {
      const manifest: ServiceManifest = {
        name: "my-service",
        version: "1.0.0",
        tools: [
          {
            name: "users.get",
            description: "Get a user",
            parameters: {},
            method: "GET",
            path: "/users/:id",
            dispatch: "body",
          },
        ],
      };

      manifestFetcher.fetchAndStore.mockResolvedValue(manifest);

      const decl = createProcessDeclaration({
        id: "my-svc",
        service: {
          port: 3000,
          protocol: "http",
          basePath: "/",
          host: "127.0.0.1",
          expose: "direct",
          manifestPath: "/manifest",
        },
      });

      await manager.onProcessStarted("my-svc", decl);

      expect(manifestFetcher.fetchAndStore).toHaveBeenCalledWith("my-svc", "/manifest");
      expect(toolRegistry.registerServiceTools).toHaveBeenCalledWith("my-svc", manifest);
    });

    it("does nothing if no service declaration", async () => {
      const decl = createProcessDeclaration({ id: "plain-proc" });

      await manager.onProcessStarted("plain-proc", decl);

      expect(registry.register).not.toHaveBeenCalled();
      expect(manifestFetcher.fetchAndStore).not.toHaveBeenCalled();
      expect(toolRegistry.registerServiceTools).not.toHaveBeenCalled();
    });
  });

  describe("onProcessStopped", () => {
    it("deregisters tools and service", async () => {
      const decl = createProcessDeclaration({
        id: "my-svc",
        service: {
          port: 3000,
          protocol: "http",
          basePath: "/",
          host: "127.0.0.1",
          expose: "direct",
          manifestPath: "/manifest",
        },
      });

      await manager.onProcessStarted("my-svc", decl);
      await manager.onProcessStopped("my-svc");

      expect(toolRegistry.deregisterServiceTools).toHaveBeenCalledWith("my-svc");
      expect(registry.deregister).toHaveBeenCalledWith("my-svc");
    });
  });

  describe("onProcessHealthChanged", () => {
    it("marks service healthy when healthy is true", () => {
      manager.onProcessHealthChanged("my-svc", true);
      expect(registry.markHealthy).toHaveBeenCalledWith("my-svc");
    });

    it("marks service unhealthy when healthy is false", () => {
      manager.onProcessHealthChanged("my-svc", false);
      expect(registry.markUnhealthy).toHaveBeenCalledWith("my-svc");
    });
  });

  describe("registerExternalServices", () => {
    it("registers services and starts health polling", async () => {
      const services = [
        {
          id: "ext-svc",
          label: "External Service",
          host: "192.168.1.10",
          port: 8080,
          protocol: "http" as const,
          basePath: "/api",
          capabilities: ["data"],
          expose: "gateway" as const,
          manifestPath: "/manifest",
          health: { kind: "http" as const, url: "http://192.168.1.10:8080/health" },
          healthIntervalMs: 15000,
        },
      ];

      await manager.registerExternalServices(services);

      expect(registry.register).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "ext-svc",
          url: "http://192.168.1.10:8080/api",
          healthy: false,
          capabilities: ["data"],
          expose: "gateway",
        }),
      );

      expect(healthChecker.startPolling).toHaveBeenCalledWith(
        "ext-svc",
        { kind: "http", url: "http://192.168.1.10:8080/health" },
        15000,
      );
    });

    it("fetches manifest and registers tools for external services", async () => {
      const manifest: ServiceManifest = {
        name: "ext-service",
        version: "2.0.0",
        tools: [
          {
            name: "orders.list",
            description: "List orders",
            parameters: {},
            method: "GET",
            path: "/orders",
            dispatch: "query",
          },
        ],
      };

      manifestFetcher.fetchAndStore.mockResolvedValue(manifest);

      const services = [
        {
          id: "ext-svc",
          host: "10.0.0.1",
          port: 9090,
          protocol: "http" as const,
          basePath: "/",
          expose: "direct" as const,
          manifestPath: "/manifest",
          health: { kind: "tcp" as const, port: 9090 },
          healthIntervalMs: 30000,
        },
      ];

      await manager.registerExternalServices(services);

      expect(manifestFetcher.fetchAndStore).toHaveBeenCalledWith("ext-svc", "/manifest");
      expect(toolRegistry.registerServiceTools).toHaveBeenCalledWith("ext-svc", manifest);
    });
  });

  describe("shutdown", () => {
    it("stops all health polling and deregisters all managed services", async () => {
      const decl = createProcessDeclaration({
        id: "svc-a",
        service: {
          port: 3000,
          protocol: "http",
          basePath: "/",
          host: "127.0.0.1",
          expose: "direct",
          manifestPath: "/manifest",
        },
      });

      await manager.onProcessStarted("svc-a", decl);

      await manager.shutdown();

      expect(healthChecker.stopAll).toHaveBeenCalled();
      expect(toolRegistry.deregisterServiceTools).toHaveBeenCalledWith("svc-a");
      expect(registry.deregister).toHaveBeenCalledWith("svc-a");
    });

    it("deregisters all services including external ones", async () => {
      const services = [
        {
          id: "ext-1",
          host: "10.0.0.1",
          port: 8080,
          protocol: "http" as const,
          basePath: "/",
          expose: "direct" as const,
          manifestPath: "/manifest",
          health: { kind: "tcp" as const, port: 8080 },
          healthIntervalMs: 30000,
        },
      ];

      await manager.registerExternalServices(services);
      await manager.shutdown();

      expect(healthChecker.stopAll).toHaveBeenCalled();
      expect(toolRegistry.deregisterServiceTools).toHaveBeenCalledWith("ext-1");
      expect(registry.deregister).toHaveBeenCalledWith("ext-1");
    });
  });
});
