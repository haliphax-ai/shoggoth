import { describe, it, expect, beforeEach, vi } from "vitest";
import { ServiceToolRegistry } from "../src/service-tool-registry";
import { ServiceRegistry } from "../src/service-registry";

describe("ServiceToolRegistry", () => {
  let serviceRegistry: ServiceRegistry;
  let toolRegistry: ServiceToolRegistry;

  beforeEach(() => {
    serviceRegistry = new ServiceRegistry();
    toolRegistry = new ServiceToolRegistry(serviceRegistry);

    // Register a service entry so the tool registry can update registeredTools
    serviceRegistry.register({
      id: "demo",
      label: "Demo Service",
      url: "http://127.0.0.1:4000",
      wsUrl: undefined,
      healthy: true,
      capabilities: ["tools"],
      expose: "direct",
      manifest: null,
      registeredTools: [],
    });
  });

  describe("registerDirectTools", () => {
    it("should register tools and return their names", () => {
      const handler = vi.fn().mockResolvedValue({ resultJson: '{"ok":true}' });
      const tools = [
        {
          name: "demo.set_message",
          description: "Set a message",
          parameters: {
            type: "object" as const,
            properties: { message: { type: "string" } },
            required: ["message"],
          },
          handler,
        },
      ];

      const registered = toolRegistry.registerDirectTools("demo", tools);
      expect(registered).toEqual(["demo.set_message"]);
    });

    it("should update the service entry's registeredTools array", () => {
      const handler = vi.fn().mockResolvedValue({ resultJson: '{"ok":true}' });
      const tools = [
        {
          name: "demo.set_message",
          description: "Set a message",
          parameters: {
            type: "object" as const,
            properties: { message: { type: "string" } },
            required: ["message"],
          },
          handler,
        },
        {
          name: "demo.get_message",
          description: "Get a message",
          parameters: { type: "object" as const, properties: {}, required: [] },
          handler,
        },
      ];

      toolRegistry.registerDirectTools("demo", tools);
      const entry = serviceRegistry.get("demo");
      expect(entry?.registeredTools).toContain("demo.set_message");
      expect(entry?.registeredTools).toContain("demo.get_message");
    });
  });

  describe("invokeTool", () => {
    it("should call the handler with correct args and context", async () => {
      const handler = vi.fn().mockResolvedValue({ resultJson: '{"ok":true}' });
      const tools = [
        {
          name: "demo.set_message",
          description: "Set a message",
          parameters: {
            type: "object" as const,
            properties: { message: { type: "string" } },
            required: ["message"],
          },
          handler,
        },
      ];

      toolRegistry.registerDirectTools("demo", tools);

      const result = await toolRegistry.invokeTool(
        "demo.set_message",
        { message: "hello" },
        { agentId: "test-agent", sessionUrn: "urn:session:abc" },
      );

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(
        { message: "hello" },
        { agentId: "test-agent", sessionUrn: "urn:session:abc" },
      );
      expect(result).toEqual({ resultJson: '{"ok":true}' });
    });

    it("should throw for unknown tool", async () => {
      await expect(
        toolRegistry.invokeTool(
          "nonexistent.tool",
          {},
          { agentId: "test-agent", sessionUrn: "urn:session:abc" },
        ),
      ).rejects.toThrow("Unknown tool: nonexistent.tool");
    });
  });

  describe("deregisterServiceTools", () => {
    it("should remove all tools for a service", () => {
      const handler = vi.fn().mockResolvedValue({ resultJson: '{"ok":true}' });
      const tools = [
        {
          name: "demo.set_message",
          description: "Set a message",
          parameters: {
            type: "object" as const,
            properties: { message: { type: "string" } },
            required: ["message"],
          },
          handler,
        },
        {
          name: "demo.get_message",
          description: "Get a message",
          parameters: { type: "object" as const, properties: {}, required: [] },
          handler,
        },
      ];

      toolRegistry.registerDirectTools("demo", tools);
      toolRegistry.deregisterServiceTools("demo");

      expect(toolRegistry.getToolDeclaration("demo.set_message")).toBeUndefined();
      expect(toolRegistry.getToolDeclaration("demo.get_message")).toBeUndefined();
    });

    it("should clear the service entry's registeredTools array", () => {
      const handler = vi.fn().mockResolvedValue({ resultJson: '{"ok":true}' });
      const tools = [
        {
          name: "demo.set_message",
          description: "Set a message",
          parameters: {
            type: "object" as const,
            properties: { message: { type: "string" } },
            required: ["message"],
          },
          handler,
        },
      ];

      toolRegistry.registerDirectTools("demo", tools);
      toolRegistry.deregisterServiceTools("demo");

      const entry = serviceRegistry.get("demo");
      expect(entry?.registeredTools).toEqual([]);
    });
  });

  describe("listTools", () => {
    it("should list all registered direct tools", () => {
      const handler = vi.fn().mockResolvedValue({ resultJson: '{"ok":true}' });
      const tools = [
        {
          name: "demo.set_message",
          description: "Set a message",
          parameters: {
            type: "object" as const,
            properties: { message: { type: "string" } },
            required: ["message"],
          },
          handler,
        },
        {
          name: "demo.get_message",
          description: "Get the current message",
          parameters: { type: "object" as const, properties: {}, required: [] },
          handler,
        },
      ];

      toolRegistry.registerDirectTools("demo", tools);
      const list = toolRegistry.listTools();

      expect(list).toHaveLength(2);
      expect(list).toContainEqual({
        qualifiedName: "demo.set_message",
        serviceId: "demo",
        description: "Set a message",
      });
      expect(list).toContainEqual({
        qualifiedName: "demo.get_message",
        serviceId: "demo",
        description: "Get the current message",
      });
    });

    it("should return empty array when no tools registered", () => {
      const list = toolRegistry.listTools();
      expect(list).toEqual([]);
    });
  });

  describe("getToolDeclaration", () => {
    it("should return the registered tool info for a direct tool", () => {
      const handler = vi.fn().mockResolvedValue({ resultJson: '{"ok":true}' });
      const tools = [
        {
          name: "demo.set_message",
          description: "Set a message",
          parameters: {
            type: "object" as const,
            properties: { message: { type: "string" } },
            required: ["message"],
          },
          handler,
        },
      ];

      toolRegistry.registerDirectTools("demo", tools);
      const decl = toolRegistry.getToolDeclaration("demo.set_message");

      expect(decl).toBeDefined();
      expect(decl!.kind).toBe("direct");
      expect(decl!.serviceId).toBe("demo");
      expect(decl!.tool.name).toBe("demo.set_message");
      expect(decl!.tool.description).toBe("Set a message");
    });

    it("should return undefined for unknown tool", () => {
      const decl = toolRegistry.getToolDeclaration("nonexistent.tool");
      expect(decl).toBeUndefined();
    });
  });
});
