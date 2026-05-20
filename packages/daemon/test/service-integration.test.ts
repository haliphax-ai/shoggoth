/**
 * Integration tests for the agent-facing service tool flow
 *
 * Tests the complete lifecycle: approval gating, tool routing, manifest changes,
 * and service deregistration.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { ServiceRegistry, ServiceManifest } from "../src/service-registry";
import { ServiceToolRegistry } from "../src/service-tool-registry";
import { ServiceToolDispatcher } from "../src/service-tool-dispatcher";

/**
 * Helper function to get approved service tools.
 * Filters tools from ServiceToolRegistry to only include those from services
 * where approvalStatus === 'approved'.
 */
function getApprovedServiceTools(
  serviceRegistry: ServiceRegistry,
  toolRegistry: ServiceToolRegistry,
): Array<{ qualifiedName: string; serviceId: string; description: string }> {
  const allTools = toolRegistry.listTools();
  return allTools.filter((tool) => {
    const entry = serviceRegistry.get(tool.serviceId);
    return entry?.approvalStatus === "approved";
  });
}

describe("Service Tool Integration", () => {
  let serviceRegistry: ServiceRegistry;
  let toolRegistry: ServiceToolRegistry;
  let dispatcher: ServiceToolDispatcher;

  beforeEach(() => {
    serviceRegistry = new ServiceRegistry();
    dispatcher = new ServiceToolDispatcher(serviceRegistry);
    toolRegistry = new ServiceToolRegistry(serviceRegistry, dispatcher);
  });

  describe("Service tool finalizer - getApprovedServiceTools", () => {
    it("should only include tools from approved services", () => {
      // Register approved service with tools
      serviceRegistry.register({
        id: "approved-service",
        label: "Approved Service",
        tier: "managed",
        url: "http://127.0.0.1:3001",
        healthy: true,
        capabilities: ["tools"],
        expose: "gateway",
        manifest: null,
        registeredTools: [],
        approvalStatus: "approved",
      });

      const approvedManifest: ServiceManifest = {
        name: "approved-service",
        version: "1.0.0",
        tools: [
          {
            name: "approved.tool_one",
            description: "Tool from approved service",
            parameters: { type: "object", properties: {} },
            method: "POST",
            path: "/api/tool_one",
          },
          {
            name: "approved.tool_two",
            description: "Another tool from approved service",
            parameters: { type: "object", properties: {} },
            method: "GET",
            path: "/api/tool_two",
          },
        ],
      };

      toolRegistry.registerServiceTools("approved-service", approvedManifest);

      // Register pending service with tools
      serviceRegistry.register({
        id: "pending-service",
        label: "Pending Service",
        tier: "managed",
        url: "http://127.0.0.1:3002",
        healthy: true,
        capabilities: ["tools"],
        expose: "gateway",
        manifest: null,
        registeredTools: [],
        approvalStatus: "pending",
      });

      const pendingManifest: ServiceManifest = {
        name: "pending-service",
        version: "1.0.0",
        tools: [
          {
            name: "pending.tool_one",
            description: "Tool from pending service",
            parameters: { type: "object", properties: {} },
            method: "POST",
            path: "/api/tool_one",
          },
        ],
      };

      toolRegistry.registerServiceTools("pending-service", pendingManifest);

      // Get approved tools - should only include approved service tools
      const approvedTools = getApprovedServiceTools(serviceRegistry, toolRegistry);

      expect(approvedTools).toHaveLength(2);
      expect(approvedTools.map((t) => t.qualifiedName)).toContain("approved.tool_one");
      expect(approvedTools.map((t) => t.qualifiedName)).toContain("approved.tool_two");
      expect(approvedTools.map((t) => t.qualifiedName)).not.toContain("pending.tool_one");
    });

    it("should include tools from services in all approved states", () => {
      // Test that 'pending-reapproval' also blocks tools (same as pending)
      serviceRegistry.register({
        id: "approved-service",
        label: "Approved Service",
        tier: "managed",
        url: "http://127.0.0.1:3001",
        healthy: true,
        capabilities: ["tools"],
        expose: "gateway",
        manifest: null,
        registeredTools: [],
        approvalStatus: "approved",
      });

      const approvedManifest: ServiceManifest = {
        name: "approved-service",
        version: "1.0.0",
        tools: [
          {
            name: "approved.tool",
            description: "Tool from approved service",
            parameters: { type: "object", properties: {} },
            method: "POST",
            path: "/api/tool",
          },
        ],
      };

      toolRegistry.registerServiceTools("approved-service", approvedManifest);

      // Add a pending-reapproval service
      serviceRegistry.register({
        id: "reapproval-service",
        label: "Reapproval Service",
        tier: "managed",
        url: "http://127.0.0.1:3003",
        healthy: true,
        capabilities: ["tools"],
        expose: "gateway",
        manifest: null,
        registeredTools: [],
        approvalStatus: "pending-reapproval",
      });

      const reapprovalManifest: ServiceManifest = {
        name: "reapproval-service",
        version: "1.0.0",
        tools: [
          {
            name: "reapproval.tool",
            description: "Tool from reapproval service",
            parameters: { type: "object", properties: {} },
            method: "POST",
            path: "/api/tool",
          },
        ],
      };

      toolRegistry.registerServiceTools("reapproval-service", reapprovalManifest);

      const approvedTools = getApprovedServiceTools(serviceRegistry, toolRegistry);

      // Should only include the approved service tool
      expect(approvedTools).toHaveLength(1);
      expect(approvedTools[0].qualifiedName).toBe("approved.tool");
    });
  });

  describe("Tool routing via ServiceToolDispatcher", () => {
    it("should route tool calls through dispatcher for HTTP tools", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('{"ok":true,"data":"test"}'),
      });
      vi.stubGlobal("fetch", fetchMock);

      serviceRegistry.register({
        id: "canvas-service",
        label: "Canvas Service",
        tier: "managed",
        url: "http://127.0.0.1:3000",
        healthy: true,
        capabilities: ["tools"],
        expose: "gateway",
        manifest: null,
        registeredTools: [],
        approvalStatus: "approved",
      });

      const manifest: ServiceManifest = {
        name: "canvas-service",
        version: "1.0.0",
        tools: [
          {
            name: "canvas.push",
            description: "Push an A2UI surface to the canvas",
            parameters: {
              type: "object",
              properties: { surface: { type: "string" } },
              required: ["surface"],
            },
            method: "POST",
            path: "/api/a2ui/push",
          },
        ],
      };

      toolRegistry.registerServiceTools("canvas-service", manifest);

      const result = await toolRegistry.invokeTool(
        "canvas.push",
        { surface: "main" },
        { agentId: "test-agent", sessionUrn: "urn:session:abc" },
      );

      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:3000/api/a2ui/push",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ surface: "main" }),
          headers: expect.objectContaining({
            "Content-Type": "application/json",
          }),
        }),
      );

      expect(result).toEqual({ resultJson: '{"ok":true,"data":"test"}' });
      vi.unstubAllGlobals();
    });
  });

  describe("Approval gating - pending/revoked services", () => {
    it("should NOT include tools from pending services in approved list", () => {
      serviceRegistry.register({
        id: "pending-service",
        label: "Pending Service",
        tier: "managed",
        url: "http://127.0.0.1:3001",
        healthy: true,
        capabilities: ["tools"],
        expose: "gateway",
        manifest: null,
        registeredTools: [],
        approvalStatus: "pending",
      });

      const manifest: ServiceManifest = {
        name: "pending-service",
        version: "1.0.0",
        tools: [
          {
            name: "pending.tool",
            description: "Tool from pending service",
            parameters: { type: "object", properties: {} },
            method: "POST",
            path: "/api/tool",
          },
        ],
      };

      toolRegistry.registerServiceTools("pending-service", manifest);

      const approvedTools = getApprovedServiceTools(serviceRegistry, toolRegistry);

      expect(approvedTools).toHaveLength(0);
    });

    it("should NOT include tools from revoked services in approved list", () => {
      serviceRegistry.register({
        id: "revoked-service",
        label: "Revoked Service",
        tier: "managed",
        url: "http://127.0.0.1:3001",
        healthy: true,
        capabilities: ["tools"],
        expose: "gateway",
        manifest: null,
        registeredTools: [],
        approvalStatus: "revoked",
      });

      const manifest: ServiceManifest = {
        name: "revoked-service",
        version: "1.0.0",
        tools: [
          {
            name: "revoked.tool",
            description: "Tool from revoked service",
            parameters: { type: "object", properties: {} },
            method: "POST",
            path: "/api/tool",
          },
        ],
      };

      toolRegistry.registerServiceTools("revoked-service", manifest);

      const approvedTools = getApprovedServiceTools(serviceRegistry, toolRegistry);

      expect(approvedTools).toHaveLength(0);
    });

    it("should filter out tools when approval status changes to pending", () => {
      // Start with approved service
      serviceRegistry.register({
        id: "service",
        label: "Test Service",
        tier: "managed",
        url: "http://127.0.0.1:3001",
        healthy: true,
        capabilities: ["tools"],
        expose: "gateway",
        manifest: null,
        registeredTools: [],
        approvalStatus: "approved",
      });

      const manifest: ServiceManifest = {
        name: "test-service",
        version: "1.0.0",
        tools: [
          {
            name: "test.tool",
            description: "Test tool",
            parameters: { type: "object", properties: {} },
            method: "POST",
            path: "/api/tool",
          },
        ],
      };

      toolRegistry.registerServiceTools("service", manifest);

      // Initially should be in approved list
      let approvedTools = getApprovedServiceTools(serviceRegistry, toolRegistry);
      expect(approvedTools).toHaveLength(1);

      // Change status to pending (simulating manifest fingerprint change / pending-reapproval)
      serviceRegistry.setApprovalStatus("service", "pending-reapproval");

      // Now should NOT be in approved list
      approvedTools = getApprovedServiceTools(serviceRegistry, toolRegistry);
      expect(approvedTools).toHaveLength(0);
    });

    it("should filter out tools when approval status changes to revoked", () => {
      serviceRegistry.register({
        id: "service",
        label: "Test Service",
        tier: "managed",
        url: "http://127.0.0.1:3001",
        healthy: true,
        capabilities: ["tools"],
        expose: "gateway",
        manifest: null,
        registeredTools: [],
        approvalStatus: "approved",
      });

      const manifest: ServiceManifest = {
        name: "test-service",
        version: "1.0.0",
        tools: [
          {
            name: "test.tool",
            description: "Test tool",
            parameters: { type: "object", properties: {} },
            method: "POST",
            path: "/api/tool",
          },
        ],
      };

      toolRegistry.registerServiceTools("service", manifest);

      // Initially approved
      let approvedTools = getApprovedServiceTools(serviceRegistry, toolRegistry);
      expect(approvedTools).toHaveLength(1);

      // Revoke the service
      serviceRegistry.setApprovalStatus("service", "revoked");

      // Should no longer be in approved list
      approvedTools = getApprovedServiceTools(serviceRegistry, toolRegistry);
      expect(approvedTools).toHaveLength(0);
    });
  });

  describe("Manifest change handling", () => {
    it("should remove tools when service goes to pending-reapproval", () => {
      serviceRegistry.register({
        id: "manifest-service",
        label: "Manifest Service",
        tier: "managed",
        url: "http://127.0.0.1:3001",
        healthy: true,
        capabilities: ["tools"],
        expose: "gateway",
        manifest: null,
        registeredTools: [],
        approvalStatus: "approved",
      });

      const manifest: ServiceManifest = {
        name: "manifest-service",
        version: "1.0.0",
        tools: [
          {
            name: "manifest.tool_one",
            description: "First tool",
            parameters: { type: "object", properties: {} },
            method: "POST",
            path: "/api/tool_one",
          },
          {
            name: "manifest.tool_two",
            description: "Second tool",
            parameters: { type: "object", properties: {} },
            method: "GET",
            path: "/api/tool_two",
          },
        ],
      };

      toolRegistry.registerServiceTools("manifest-service", manifest);

      // Verify tools are registered
      let tools = toolRegistry.listTools();
      expect(tools).toHaveLength(2);

      // Simulate manifest fingerprint change - status goes to pending-reapproval
      serviceRegistry.setApprovalStatus("manifest-service", "pending-reapproval");

      // Approved list should be empty
      const approvedTools = getApprovedServiceTools(serviceRegistry, toolRegistry);
      expect(approvedTools).toHaveLength(0);

      // Tools still exist in registry but are filtered out
      tools = toolRegistry.listTools();
      expect(tools).toHaveLength(2);
    });

    it("should re-include tools when approval is restored", () => {
      serviceRegistry.register({
        id: "restore-service",
        label: "Restore Service",
        tier: "managed",
        url: "http://127.0.0.1:3001",
        healthy: true,
        capabilities: ["tools"],
        expose: "gateway",
        manifest: null,
        registeredTools: [],
        approvalStatus: "approved",
      });

      const manifest: ServiceManifest = {
        name: "restore-service",
        version: "1.0.0",
        tools: [
          {
            name: "restore.tool",
            description: "Restorable tool",
            parameters: { type: "object", properties: {} },
            method: "POST",
            path: "/api/tool",
          },
        ],
      };

      toolRegistry.registerServiceTools("restore-service", manifest);

      // Initially approved
      expect(getApprovedServiceTools(serviceRegistry, toolRegistry)).toHaveLength(1);

      // Change to pending-reapproval
      serviceRegistry.setApprovalStatus("restore-service", "pending-reapproval");
      expect(getApprovedServiceTools(serviceRegistry, toolRegistry)).toHaveLength(0);

      // Restore to approved
      serviceRegistry.setApprovalStatus("restore-service", "approved");
      expect(getApprovedServiceTools(serviceRegistry, toolRegistry)).toHaveLength(1);
    });
  });

  describe("Process stop - service deregistration", () => {
    it("should remove tools when service is deregistered", () => {
      serviceRegistry.register({
        id: "stopped-service",
        label: "Stopped Service",
        tier: "managed",
        url: "http://127.0.0.1:3001",
        healthy: true,
        capabilities: ["tools"],
        expose: "gateway",
        manifest: null,
        registeredTools: [],
        approvalStatus: "approved",
      });

      const manifest: ServiceManifest = {
        name: "stopped-service",
        version: "1.0.0",
        tools: [
          {
            name: "stopped.tool_one",
            description: "First tool",
            parameters: { type: "object", properties: {} },
            method: "POST",
            path: "/api/tool_one",
          },
          {
            name: "stopped.tool_two",
            description: "Second tool",
            parameters: { type: "object", properties: {} },
            method: "GET",
            path: "/api/tool_two",
          },
        ],
      };

      toolRegistry.registerServiceTools("stopped-service", manifest);

      // Verify tools exist
      expect(toolRegistry.listTools()).toHaveLength(2);

      // Deregister the service
      serviceRegistry.deregister("stopped-service");

      // Tools should be removed from the tool registry
      expect(toolRegistry.listTools()).toHaveLength(0);
    });

    it("should use deregisterServiceTools to remove tools", () => {
      serviceRegistry.register({
        id: "dereg-service",
        label: "Dereg Service",
        tier: "managed",
        url: "http://127.0.0.1:3001",
        healthy: true,
        capabilities: ["tools"],
        expose: "gateway",
        manifest: null,
        registeredTools: [],
        approvalStatus: "approved",
      });

      const manifest: ServiceManifest = {
        name: "dereg-service",
        version: "1.0.0",
        tools: [
          {
            name: "dereg.tool",
            description: "Tool to deregister",
            parameters: { type: "object", properties: {} },
            method: "POST",
            path: "/api/tool",
          },
        ],
      };

      toolRegistry.registerServiceTools("dereg-service", manifest);

      // Verify tool exists
      expect(toolRegistry.get("dereg.tool")).toBeDefined();

      // Use deregisterServiceTools
      toolRegistry.deregisterServiceTools("dereg-service");

      // Tool should be gone
      expect(toolRegistry.get("dereg.tool")).toBeUndefined();

      // Service entry's registeredTools should be cleared
      const entry = serviceRegistry.get("dereg-service");
      expect(entry?.registeredTools).toEqual([]);
    });

    it("should not include deregistered service tools in approved list", () => {
      serviceRegistry.register({
        id: "temp-service",
        label: "Temp Service",
        tier: "managed",
        url: "http://127.0.0.1:3001",
        healthy: true,
        capabilities: ["tools"],
        expose: "gateway",
        manifest: null,
        registeredTools: [],
        approvalStatus: "approved",
      });

      const manifest: ServiceManifest = {
        name: "temp-service",
        version: "1.0.0",
        tools: [
          {
            name: "temp.tool",
            description: "Temporary tool",
            parameters: { type: "object", properties: {} },
            method: "POST",
            path: "/api/tool",
          },
        ],
      };

      toolRegistry.registerServiceTools("temp-service", manifest);

      // Verify it's in approved list
      expect(getApprovedServiceTools(serviceRegistry, toolRegistry)).toHaveLength(1);

      // Deregister the service
      serviceRegistry.deregister("temp-service");

      // Should not appear in approved list (and shouldn't exist at all)
      expect(getApprovedServiceTools(serviceRegistry, toolRegistry)).toHaveLength(0);
    });
  });

  describe("Mixed approval states", () => {
    it("should correctly filter multiple services with different approval states", () => {
      // Approved service
      serviceRegistry.register({
        id: "approved-1",
        label: "Approved 1",
        tier: "managed",
        url: "http://127.0.0.1:3001",
        healthy: true,
        capabilities: ["tools"],
        expose: "gateway",
        manifest: null,
        registeredTools: [],
        approvalStatus: "approved",
      });

      // Another approved service
      serviceRegistry.register({
        id: "approved-2",
        label: "Approved 2",
        tier: "managed",
        url: "http://127.0.0.1:3002",
        healthy: true,
        capabilities: ["tools"],
        expose: "gateway",
        manifest: null,
        registeredTools: [],
        approvalStatus: "approved",
      });

      // Pending service
      serviceRegistry.register({
        id: "pending-1",
        label: "Pending 1",
        tier: "managed",
        url: "http://127.0.0.1:3003",
        healthy: true,
        capabilities: ["tools"],
        expose: "gateway",
        manifest: null,
        registeredTools: [],
        approvalStatus: "pending",
      });

      // Revoked service
      serviceRegistry.register({
        id: "revoked-1",
        label: "Revoked 1",
        tier: "managed",
        url: "http://127.0.0.1:3004",
        healthy: true,
        capabilities: ["tools"],
        expose: "gateway",
        manifest: null,
        registeredTools: [],
        approvalStatus: "revoked",
      });

      // Register tools for each
      toolRegistry.registerServiceTools("approved-1", {
        name: "approved-1",
        version: "1.0.0",
        tools: [
          {
            name: "approved1.tool",
            description: "Approved 1 tool",
            parameters: {},
            method: "POST" as const,
            path: "/api/tool",
          },
        ],
      });

      toolRegistry.registerServiceTools("approved-2", {
        name: "approved-2",
        version: "1.0.0",
        tools: [
          {
            name: "approved2.tool",
            description: "Approved 2 tool",
            parameters: {},
            method: "POST" as const,
            path: "/api/tool",
          },
        ],
      });

      toolRegistry.registerServiceTools("pending-1", {
        name: "pending-1",
        version: "1.0.0",
        tools: [
          {
            name: "pending1.tool",
            description: "Pending 1 tool",
            parameters: {},
            method: "POST" as const,
            path: "/api/tool",
          },
        ],
      });

      toolRegistry.registerServiceTools("revoked-1", {
        name: "revoked-1",
        version: "1.0.0",
        tools: [
          {
            name: "revoked1.tool",
            description: "Revoked 1 tool",
            parameters: {},
            method: "POST" as const,
            path: "/api/tool",
          },
        ],
      });

      const approvedTools = getApprovedServiceTools(serviceRegistry, toolRegistry);

      // Should only include tools from approved services
      expect(approvedTools).toHaveLength(2);
      expect(approvedTools.map((t) => t.qualifiedName)).toContain("approved1.tool");
      expect(approvedTools.map((t) => t.qualifiedName)).toContain("approved2.tool");
      expect(approvedTools.map((t) => t.qualifiedName)).not.toContain("pending1.tool");
      expect(approvedTools.map((t) => t.qualifiedName)).not.toContain("revoked1.tool");
    });
  });
});
