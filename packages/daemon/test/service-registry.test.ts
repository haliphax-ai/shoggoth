import { describe, it, expect, beforeEach } from "vitest";
import { ServiceRegistry, ServiceEntry } from "../src/service-registry";

/**
 * Helper function to create a mock ServiceEntry for testing.
 */
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

describe("ServiceRegistry", () => {
  let registry: ServiceRegistry;

  beforeEach(() => {
    registry = new ServiceRegistry();
  });

  describe("instantiation", () => {
    it("should create a new ServiceRegistry instance", () => {
      expect(registry).toBeInstanceOf(ServiceRegistry);
    });
  });

  describe("register and get", () => {
    it("should register a service and retrieve it by id", () => {
      const entry = createMockEntry({ id: "service-1" });
      registry.register(entry);
      const result = registry.get("service-1");
      expect(result).toEqual(entry);
    });

    it("should return undefined for non-existent service", () => {
      const result = registry.get("non-existent");
      expect(result).toBeUndefined();
    });
  });

  describe("register and list", () => {
    it("should list all registered services", () => {
      const entry1 = createMockEntry({ id: "service-1", capabilities: ["cap1"] });
      const entry2 = createMockEntry({ id: "service-2", capabilities: ["cap2"] });
      registry.register(entry1);
      registry.register(entry2);
      const result = registry.list();
      expect(result).toHaveLength(2);
      expect(result).toContainEqual(entry1);
      expect(result).toContainEqual(entry2);
    });

    it("should return empty array when no services registered", () => {
      const result = registry.list();
      expect(result).toEqual([]);
    });
  });

  describe("deregister", () => {
    it("should remove a service from the registry", () => {
      const entry = createMockEntry({ id: "service-to-remove" });
      registry.register(entry);
      registry.deregister("service-to-remove");
      const result = registry.get("service-to-remove");
      expect(result).toBeUndefined();
    });

    it("should not throw when deregistering non-existent service", () => {
      expect(() => {
        registry.deregister("non-existent");
      }).not.toThrow();
    });
  });

  describe("markUnhealthy", () => {
    it("should set healthy to false for a service", () => {
      const entry = createMockEntry({ id: "unhealthy-service", healthy: true });
      registry.register(entry);
      registry.markUnhealthy("unhealthy-service");
      const result = registry.get("unhealthy-service");
      expect(result?.healthy).toBe(false);
    });
  });

  describe("markHealthy", () => {
    it("should set healthy to true for a service", () => {
      const entry = createMockEntry({ id: "healthy-service", healthy: false });
      registry.register(entry);
      registry.markHealthy("healthy-service");
      const result = registry.get("healthy-service");
      expect(result?.healthy).toBe(true);
    });
  });

  describe("findByCapability", () => {
    it("should return services that have the specified capability", () => {
      const entry1 = createMockEntry({
        id: "service-1",
        capabilities: ["capability-a", "capability-b"],
      });
      const entry2 = createMockEntry({
        id: "service-2",
        capabilities: ["capability-b", "capability-c"],
      });
      const entry3 = createMockEntry({
        id: "service-3",
        capabilities: ["capability-c"],
      });
      registry.register(entry1);
      registry.register(entry2);
      registry.register(entry3);

      const result = registry.findByCapability("capability-b");
      expect(result).toHaveLength(2);
      expect(result).toContainEqual(entry1);
      expect(result).toContainEqual(entry2);
    });

    it("should return empty array when no services have the capability", () => {
      const entry = createMockEntry({
        id: "service-1",
        capabilities: ["unique-cap"],
      });
      registry.register(entry);

      const result = registry.findByCapability("non-existent-cap");
      expect(result).toEqual([]);
    });
  });

  describe("duplicate registration", () => {
    it("should throw when registering a service with duplicate id", () => {
      const entry1 = createMockEntry({ id: "duplicate-id" });
      const entry2 = createMockEntry({ id: "duplicate-id" });
      registry.register(entry1);

      expect(() => {
        registry.register(entry2);
      }).toThrow();
    });
  });
});
