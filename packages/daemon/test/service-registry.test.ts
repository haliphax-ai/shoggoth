import { describe, it, expect, beforeEach } from "vitest";
import { ServiceRegistry, ServiceEntry, ApprovalStatus } from "../src/service-registry";

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

  describe("tier field", () => {
    it("should accept plugin tier", () => {
      const entry = createMockEntry({ id: "plugin-service", tier: "plugin" });
      registry.register(entry);
      const result = registry.get("plugin-service");
      expect(result?.tier).toBe("plugin");
    });

    it("should accept managed tier", () => {
      const entry = createMockEntry({ id: "managed-service", tier: "managed" });
      registry.register(entry);
      const result = registry.get("managed-service");
      expect(result?.tier).toBe("managed");
    });

    it("should accept external tier", () => {
      const entry = createMockEntry({ id: "external-service", tier: "external" });
      registry.register(entry);
      const result = registry.get("external-service");
      expect(result?.tier).toBe("external");
    });
  });

  describe("approvalStatus", () => {
    it("should default to pending when not specified", () => {
      const entry = createMockEntry({ id: "service-1", approvalStatus: "pending" });
      registry.register(entry);
      const result = registry.get("service-1");
      expect(result?.approvalStatus).toBe("pending");
    });

    it("should allow approved status", () => {
      const entry = createMockEntry({ id: "service-1", approvalStatus: "approved" });
      registry.register(entry);
      const result = registry.get("service-1");
      expect(result?.approvalStatus).toBe("approved");
    });

    it("should allow pending-reapproval status", () => {
      const entry = createMockEntry({ id: "service-1", approvalStatus: "pending-reapproval" });
      registry.register(entry);
      const result = registry.get("service-1");
      expect(result?.approvalStatus).toBe("pending-reapproval");
    });

    it("should allow revoked status", () => {
      const entry = createMockEntry({ id: "service-1", approvalStatus: "revoked" });
      registry.register(entry);
      const result = registry.get("service-1");
      expect(result?.approvalStatus).toBe("revoked");
    });
  });

  describe("setApprovalStatus", () => {
    it("should update approval status on a service entry", () => {
      const entry = createMockEntry({ id: "service-1", approvalStatus: "pending" });
      registry.register(entry);
      registry.setApprovalStatus("service-1", "approved");
      const result = registry.get("service-1");
      expect(result?.approvalStatus).toBe("approved");
    });

    it("should emit approval-changed event", () => {
      const entry = createMockEntry({ id: "service-1", approvalStatus: "pending" });
      registry.register(entry);

      const emitted: Array<{ id: string; status: ApprovalStatus }> = [];
      registry.on("approval-changed", (data) => emitted.push(data));

      registry.setApprovalStatus("service-1", "approved");

      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toEqual({ id: "service-1", status: "approved" });
    });

    it("should not throw for non-existent service", () => {
      expect(() => {
        registry.setApprovalStatus("non-existent", "approved");
      }).not.toThrow();
    });
  });

  describe("manifest field", () => {
    it("should store null manifest initially", () => {
      const entry = createMockEntry({ id: "service-1", manifest: null });
      registry.register(entry);
      const result = registry.get("service-1");
      expect(result?.manifest).toBeNull();
    });

    it("should store manifest when provided", () => {
      const manifest = {
        name: "test-service",
        version: "1.0.0",
        tools: [],
      };
      const entry = createMockEntry({ id: "service-1", manifest });
      registry.register(entry);
      const result = registry.get("service-1");
      expect(result?.manifest).toEqual(manifest);
    });
  });
});
