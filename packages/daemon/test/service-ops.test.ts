import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WireRequest } from "@shoggoth/authn";
import type { AuthenticatedPrincipal } from "@shoggoth/authn";
import type { IntegrationOpsContext } from "../src/control/integration-ops";
import type { ServiceApprovalStore } from "../src/service-approval-store";
import type { ServiceRegistry } from "../src/service-registry";
import type { ServiceToolRegistry } from "../src/service-tool-registry";

// Import the handlers we'll test (will fail until implemented)
import {
  handleServiceList,
  handleServiceRequests,
  handleServiceRequest,
  handleServiceApprove,
  handleServiceRevoke,
} from "../src/control/service-ops";

describe("service-ops", () => {
  let mockApprovalStore: ServiceApprovalStore;
  let mockServiceRegistry: ServiceRegistry;
  let mockToolRegistry: ServiceToolRegistry;
  let mockCtx: IntegrationOpsContext;
  let mockPrincipal: AuthenticatedPrincipal;

  beforeEach(() => {
    // Create mock stores
    mockApprovalStore = {
      get: vi.fn(),
      list: vi.fn(),
      approve: vi.fn(),
      revoke: vi.fn(),
    } as unknown as ServiceApprovalStore;

    mockServiceRegistry = {
      get: vi.fn(),
      list: vi.fn(),
    } as unknown as ServiceRegistry;

    mockToolRegistry = {
      listTools: vi.fn(),
      deregisterServiceTools: vi.fn(),
    } as unknown as ServiceToolRegistry;

    // Mock context with stores
    mockCtx = {
      serviceApprovalStore: mockApprovalStore,
      serviceRegistry: mockServiceRegistry,
      serviceToolRegistry: mockToolRegistry,
    } as unknown as IntegrationOpsContext;

    // Mock operator principal
    mockPrincipal = { kind: "operator" as const, token: "test-token" };
  });

  describe("service.list", () => {
    it("returns all services from approval store + registry merged", async () => {
      // Setup mock approval records
      vi.mocked(mockApprovalStore.list).mockReturnValue([
        {
          serviceId: "svc-1",
          status: "approved" as const,
          approvedFingerprint: "fp1",
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
        },
        {
          serviceId: "svc-2",
          status: "pending" as const,
          approvedFingerprint: null,
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
        },
        {
          serviceId: "svc-3",
          status: "revoked" as const,
          approvedFingerprint: "fp3",
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
        },
      ]);

      // Setup mock registry entries
      vi.mocked(mockServiceRegistry.list).mockReturnValue([
        {
          id: "svc-1",
          label: "Service 1",
          tier: "managed" as const,
          url: "http://localhost:8080",
          healthy: true,
          capabilities: ["cap1", "cap2"],
          expose: "gateway" as const,
          manifest: null,
          registeredTools: ["tool1", "tool2"],
          approvalStatus: "approved" as const,
        },
        {
          id: "svc-2",
          label: "Service 2",
          tier: "external" as const,
          url: "http://external:9000",
          healthy: true,
          capabilities: ["cap3"],
          expose: "direct" as const,
          manifest: null,
          registeredTools: [],
          approvalStatus: "pending" as const,
        },
      ]);

      vi.mocked(mockToolRegistry.listTools).mockReturnValue([
        { qualifiedName: "tool1", serviceId: "svc-1", description: "Tool 1" },
        { qualifiedName: "tool2", serviceId: "svc-1", description: "Tool 2" },
      ]);

      const req: WireRequest = {
        id: "test-1",
        op: "service.list",
        auth: { kind: "operator_token", token: "test" },
        payload: {},
      };

      const result = await handleServiceList(req, mockPrincipal, mockCtx);

      expect(result).toHaveProperty("services");
      expect(Array.isArray((result as { services: unknown }).services)).toBe(true);
      const services = result as {
        services: Array<{
          id: string;
          tier: string;
          status: string;
          tools: number;
          capabilities: string[];
        }>;
      };
      expect(services.services).toHaveLength(2);

      // Check service 1
      const svc1 = services.services.find((s) => s.id === "svc-1");
      expect(svc1).toBeDefined();
      expect(svc1?.tier).toBe("managed");
      expect(svc1?.status).toBe("approved");
      expect(svc1?.tools).toBe(2);
      expect(svc1?.capabilities).toEqual(["cap1", "cap2"]);
    });

    it("returns empty array when no services exist", async () => {
      vi.mocked(mockApprovalStore.list).mockReturnValue([]);
      vi.mocked(mockServiceRegistry.list).mockReturnValue([]);

      const req: WireRequest = {
        id: "test-2",
        op: "service.list",
        auth: { kind: "operator_token", token: "test" },
        payload: {},
      };

      const result = await handleServiceList(req, mockPrincipal, mockCtx);

      expect(result).toHaveProperty("services");
      expect((result as { services: unknown[] }).services).toHaveLength(0);
    });
  });

  describe("service.requests", () => {
    it("returns pending and pending-reapproval services", async () => {
      vi.mocked(mockApprovalStore.list).mockReturnValue([
        {
          serviceId: "svc-pending",
          status: "pending" as const,
          approvedFingerprint: null,
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
        },
        {
          serviceId: "svc-reapproval",
          status: "pending-reapproval" as const,
          approvedFingerprint: "new-fp",
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-02T00:00:00Z",
        },
        {
          serviceId: "svc-approved",
          status: "approved" as const,
          approvedFingerprint: "fp",
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
        },
      ]);

      vi.mocked(mockServiceRegistry.get).mockImplementation((id: string) => {
        if (id === "svc-pending") {
          return {
            id: "svc-pending",
            label: "Pending Service",
            tier: "managed" as const,
            url: "http://localhost:8080",
            healthy: true,
            capabilities: ["cap1"],
            expose: "gateway" as const,
            manifest: null,
            registeredTools: [],
            approvalStatus: "pending" as const,
          };
        }
        if (id === "svc-reapproval") {
          return {
            id: "svc-reapproval",
            label: "Reapproval Service",
            tier: "managed" as const,
            url: "http://localhost:8081",
            healthy: true,
            capabilities: ["cap2"],
            expose: "direct" as const,
            manifest: null,
            registeredTools: ["tool1"],
            approvalStatus: "pending-reapproval" as const,
          };
        }
        return undefined;
      });

      vi.mocked(mockToolRegistry.listTools).mockReturnValue([
        { qualifiedName: "tool1", serviceId: "svc-reapproval", description: "Tool 1" },
      ]);

      const req: WireRequest = {
        id: "test-3",
        op: "service.requests",
        auth: { kind: "operator_token", token: "test" },
        payload: {},
      };

      const result = await handleServiceRequests(req, mockPrincipal, mockCtx);

      expect(result).toHaveProperty("requests");
      const requests = result as { requests: Array<{ id: string; status: string }> };
      expect(requests.requests).toHaveLength(2);
      expect(requests.requests.map((r) => r.status).sort()).toEqual([
        "pending",
        "pending-reapproval",
      ]);
    });

    it("returns empty array when no pending requests", async () => {
      vi.mocked(mockApprovalStore.list).mockReturnValue([
        {
          serviceId: "svc-approved",
          status: "approved" as const,
          approvedFingerprint: "fp",
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
        },
      ]);

      const req: WireRequest = {
        id: "test-4",
        op: "service.requests",
        auth: { kind: "operator_token", token: "test" },
        payload: {},
      };

      const result = await handleServiceRequests(req, mockPrincipal, mockCtx);

      expect(result).toHaveProperty("requests");
      expect((result as { requests: unknown[] }).requests).toHaveLength(0);
    });
  });

  describe("service.request", () => {
    it("returns details of a specific pending service", async () => {
      vi.mocked(mockApprovalStore.get).mockReturnValue({
        serviceId: "svc-1",
        status: "pending" as const,
        approvedFingerprint: null,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      });

      vi.mocked(mockServiceRegistry.get).mockReturnValue({
        id: "svc-1",
        label: "Test Service",
        tier: "managed" as const,
        url: "http://localhost:8080",
        healthy: true,
        capabilities: ["cap1", "cap2"],
        expose: "gateway" as const,
        manifest: {
          name: "test-service",
          version: "1.0.0",
          tools: [
            {
              name: "tool1",
              description: "Tool 1 description",
              parameters: { type: "object" },
              method: "POST" as const,
              path: "/api/tool1",
            },
            {
              name: "tool2",
              description: "Tool 2 description",
              parameters: { type: "object", properties: { arg: { type: "string" } } },
              method: "GET" as const,
              path: "/api/tool2",
            },
          ],
          ops: ["session_queue_manage", "vault.get"],
        },
        registeredTools: ["tool1", "tool2"],
        approvalStatus: "pending" as const,
      });

      vi.mocked(mockToolRegistry.listTools).mockReturnValue([
        { qualifiedName: "tool1", serviceId: "svc-1", description: "Tool 1 description" },
        { qualifiedName: "tool2", serviceId: "svc-1", description: "Tool 2 description" },
      ]);

      const req: WireRequest = {
        id: "test-5",
        op: "service.request",
        auth: { kind: "operator_token", token: "test" },
        payload: { service_id: "svc-1" },
      };

      const result = await handleServiceRequest(req, mockPrincipal, mockCtx);

      expect(result).toHaveProperty("service");
      const service = result as {
        service: {
          id: string;
          status: string;
          tools: Array<{ name: string; description: string; method: string; path: string }>;
          capabilities: string[];
          ops: string[];
        };
      };
      expect(service.service.id).toBe("svc-1");
      expect(service.service.status).toBe("pending");
      expect(service.service.tools).toHaveLength(2);
      expect(service.service.tools[0]).toEqual({
        name: "tool1",
        description: "Tool 1 description",
        method: "POST",
        path: "/api/tool1",
      });
      expect(service.service.capabilities).toEqual(["cap1", "cap2"]);
      expect(service.service.ops).toEqual(["session_queue_manage", "vault.get"]);
    });

    it("returns error for non-existent service", async () => {
      vi.mocked(mockApprovalStore.get).mockReturnValue(null);
      vi.mocked(mockServiceRegistry.get).mockReturnValue(undefined);

      const req: WireRequest = {
        id: "test-7",
        op: "service.request",
        auth: { kind: "operator_token", token: "test" },
        payload: { service_id: "non-existent" },
      };

      const result = await handleServiceRequest(req, mockPrincipal, mockCtx);

      expect(result).toHaveProperty("error");
      expect((result as { error: string }).error).toContain("not found");
    });
  });

  describe("service.approve", () => {
    it("approves a service and stores fingerprint", async () => {
      vi.mocked(mockApprovalStore.approve).mockReturnValue(undefined);

      vi.mocked(mockServiceRegistry.get).mockReturnValue({
        id: "svc-1",
        label: "Test Service",
        tier: "managed" as const,
        url: "http://localhost:8080",
        healthy: true,
        capabilities: ["cap1"],
        expose: "gateway" as const,
        manifest: {
          name: "test-service",
          version: "1.0.0",
          tools: [
            {
              name: "tool1",
              description: "Tool 1",
              parameters: { type: "object" },
              method: "POST" as const,
              path: "/api/tool1",
            },
          ],
        },
        registeredTools: [],
        approvalStatus: "pending" as const,
      });

      const req: WireRequest = {
        id: "test-8",
        op: "service.approve",
        auth: { kind: "operator_token", token: "test" },
        payload: { service_id: "svc-1" },
      };

      const result = await handleServiceApprove(req, mockPrincipal, mockCtx);

      expect(mockApprovalStore.approve).toHaveBeenCalledWith("svc-1", expect.any(String));
      expect(result).toHaveProperty("ok", true);
      expect(result).toHaveProperty("service_id", "svc-1");
    });

    it("returns error when approving non-existent service", async () => {
      vi.mocked(mockApprovalStore.get).mockReturnValue(null);
      vi.mocked(mockServiceRegistry.get).mockReturnValue(undefined);

      const req: WireRequest = {
        id: "test-9",
        op: "service.approve",
        auth: { kind: "operator_token", token: "test" },
        payload: { service_id: "non-existent" },
      };

      const result = await handleServiceApprove(req, mockPrincipal, mockCtx);

      expect(result).toHaveProperty("error");
      expect((result as { error: string }).error).toContain("not found");
    });

    it("approves a service even if not currently running", async () => {
      vi.mocked(mockApprovalStore.approve).mockReturnValue(undefined);
      vi.mocked(mockApprovalStore.get).mockReturnValue({
        serviceId: "offline-service",
        status: "pending",
        approvedFingerprint: null,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      });
      vi.mocked(mockServiceRegistry.get).mockReturnValue(undefined);

      const req: WireRequest = {
        id: "test-10",
        op: "service.approve",
        auth: { kind: "operator_token", token: "test" },
        payload: { service_id: "offline-service" },
      };

      const result = await handleServiceApprove(req, mockPrincipal, mockCtx);

      expect(mockApprovalStore.approve).toHaveBeenCalledWith("offline-service", expect.any(String));
      expect(result).toHaveProperty("ok", true);
    });
  });

  describe("service.revoke", () => {
    it("revokes a service and deregisters tools", async () => {
      vi.mocked(mockApprovalStore.revoke).mockReturnValue(undefined);

      vi.mocked(mockServiceRegistry.get).mockReturnValue({
        id: "svc-1",
        label: "Test Service",
        tier: "managed" as const,
        url: "http://localhost:8080",
        healthy: true,
        capabilities: ["cap1"],
        expose: "gateway" as const,
        manifest: null,
        registeredTools: ["tool1"],
        approvalStatus: "approved" as const,
      });

      const mockDeregister = vi.fn();
      vi.mocked(mockToolRegistry.deregisterServiceTools).mockImplementation(mockDeregister);

      const req: WireRequest = {
        id: "test-11",
        op: "service.revoke",
        auth: { kind: "operator_token", token: "test" },
        payload: { service_id: "svc-1" },
      };

      const result = await handleServiceRevoke(req, mockPrincipal, mockCtx);

      expect(mockApprovalStore.revoke).toHaveBeenCalledWith("svc-1");
      expect(mockDeregister).toHaveBeenCalledWith("svc-1");
      expect(result).toHaveProperty("ok", true);
      expect(result).toHaveProperty("service_id", "svc-1");
    });

    it("revokes a service even if not currently running", async () => {
      vi.mocked(mockApprovalStore.revoke).mockReturnValue(undefined);
      vi.mocked(mockServiceRegistry.get).mockReturnValue(undefined);

      const req: WireRequest = {
        id: "test-12",
        op: "service.revoke",
        auth: { kind: "operator_token", token: "test" },
        payload: { service_id: "offline-service" },
      };

      const result = await handleServiceRevoke(req, mockPrincipal, mockCtx);

      expect(mockApprovalStore.revoke).toHaveBeenCalledWith("offline-service");
      expect(result).toHaveProperty("ok", true);
    });
  });

  describe("error cases", () => {
    it("requires service_id for service.request", async () => {
      const req: WireRequest = {
        id: "test-14",
        op: "service.request",
        auth: { kind: "operator_token", token: "test" },
        payload: {},
      };

      const result = await handleServiceRequest(req, mockPrincipal, mockCtx);

      expect(result).toHaveProperty("error");
      expect((result as { error: string }).error).toContain("service_id");
    });

    it("requires service_id for service.approve", async () => {
      const req: WireRequest = {
        id: "test-15",
        op: "service.approve",
        auth: { kind: "operator_token", token: "test" },
        payload: {},
      };

      const result = await handleServiceApprove(req, mockPrincipal, mockCtx);

      expect(result).toHaveProperty("error");
      expect((result as { error: string }).error).toContain("service_id");
    });

    it("requires service_id for service.revoke", async () => {
      const req: WireRequest = {
        id: "test-16",
        op: "service.revoke",
        auth: { kind: "operator_token", token: "test" },
        payload: {},
      };

      const result = await handleServiceRevoke(req, mockPrincipal, mockCtx);

      expect(result).toHaveProperty("error");
      expect((result as { error: string }).error).toContain("service_id");
    });

    it("requires operator principal for service operations", async () => {
      const agentPrincipal = { kind: "agent" as const, sessionId: "agent:123" };

      const req: WireRequest = {
        id: "test-17",
        op: "service.list",
        auth: { kind: "operator_token", token: "test" },
        payload: {},
      };

      const result = await handleServiceList(req, agentPrincipal, mockCtx);

      expect(result).toHaveProperty("error");
      expect((result as { error: string }).error).toContain("operator");
    });
  });
});
