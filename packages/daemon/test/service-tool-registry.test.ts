import { describe, it, expect, beforeEach, vi } from "vitest";
import { ServiceToolRegistry } from "../src/service-tool-registry";
import { ServiceRegistry } from "../src/service-registry";
import { ServiceToolDispatcher } from "../src/service-tool-dispatcher";

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
      tier: "plugin",
      url: "http://127.0.0.1:4000",
      wsUrl: undefined,
      healthy: true,
      capabilities: ["tools"],
      expose: "direct",
      manifest: null,
      registeredTools: [],
      approvalStatus: "approved",
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

  describe("registerServiceTools (HTTP proxy)", () => {
    it("should register HTTP proxy tools from a manifest", () => {
      const manifest = {
        name: "canvas-web",
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
            method: "POST" as const,
            path: "/api/a2ui/push",
          },
        ],
      };

      const registered = toolRegistry.registerServiceTools("demo", manifest);
      expect(registered).toEqual(["canvas.push"]);
    });

    it("should store HTTP tool declarations with kind 'http'", () => {
      const manifest = {
        name: "canvas-web",
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
            method: "POST" as const,
            path: "/api/a2ui/push",
          },
        ],
      };

      toolRegistry.registerServiceTools("demo", manifest);
      const tool = toolRegistry.get("canvas.push");
      expect(tool).toBeDefined();
      expect(tool?.kind).toBe("http");
      expect(tool?.serviceId).toBe("demo");
      expect(tool?.decl.name).toBe("canvas.push");
      expect(tool?.decl.method).toBe("POST");
      expect(tool?.decl.path).toBe("/api/a2ui/push");
    });

    it("should update service entry registeredTools", () => {
      const manifest = {
        name: "canvas-web",
        version: "1.0.0",
        tools: [
          {
            name: "canvas.push",
            description: "Push an A2UI surface",
            parameters: { type: "object", properties: {} },
            method: "POST" as const,
            path: "/api/a2ui/push",
          },
          {
            name: "canvas.get",
            description: "Get an A2UI surface",
            parameters: { type: "object", properties: {} },
            method: "GET" as const,
            path: "/api/a2ui/get",
          },
        ],
      };

      toolRegistry.registerServiceTools("demo", manifest);
      const entry = serviceRegistry.get("demo");
      expect(entry?.registeredTools).toContain("canvas.push");
      expect(entry?.registeredTools).toContain("canvas.get");
    });

    it("should handle manifest with no tools", () => {
      const manifest = {
        name: "empty-service",
        version: "1.0.0",
      };

      const registered = toolRegistry.registerServiceTools("demo", manifest);
      expect(registered).toEqual([]);
    });

    it("should include dispatch mapping from manifest", () => {
      const manifest = {
        name: "test-service",
        version: "1.0.0",
        tools: [
          {
            name: "test.query",
            description: "Query with dispatch",
            parameters: { type: "object", properties: {} },
            method: "GET" as const,
            path: "/api/query",
            dispatch: "query" as const,
          },
        ],
      };

      toolRegistry.registerServiceTools("demo", manifest);
      const tool = toolRegistry.get("test.query");
      expect(tool?.decl.dispatch).toBe("query");
    });
  });

  describe("invokeTool", () => {
    it("should call the handler with correct args and context for direct tools", async () => {
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

    it("should throw for HTTP tools when no dispatcher is configured", async () => {
      const manifest = {
        name: "canvas-web",
        version: "1.0.0",
        tools: [
          {
            name: "canvas.push",
            description: "Push an A2UI surface",
            parameters: { type: "object", properties: {} },
            method: "POST" as const,
            path: "/api/a2ui/push",
          },
        ],
      };

      toolRegistry.registerServiceTools("demo", manifest);

      await expect(
        toolRegistry.invokeTool(
          "canvas.push",
          { surface: "main" },
          { agentId: "test-agent", sessionUrn: "urn:session:abc" },
        ),
      ).rejects.toThrow("HTTP tool dispatcher not configured");
    });

    it("should dispatch HTTP tools through configured dispatcher", async () => {
      const dispatcher = new ServiceToolDispatcher(serviceRegistry);
      const toolRegistryWithDispatcher = new ServiceToolRegistry(serviceRegistry, dispatcher);

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('{"ok":true,"surface":"main"}'),
      });
      vi.stubGlobal("fetch", fetchMock);

      const manifest = {
        name: "canvas-web",
        version: "1.0.0",
        tools: [
          {
            name: "canvas.push",
            description: "Push an A2UI surface",
            parameters: {
              type: "object",
              properties: { surface: { type: "string" } },
              required: ["surface"],
            },
            method: "POST" as const,
            path: "/api/a2ui/push",
          },
        ],
      };

      toolRegistryWithDispatcher.registerServiceTools("demo", manifest);

      const result = await toolRegistryWithDispatcher.invokeTool(
        "canvas.push",
        { surface: "main" },
        { agentId: "test-agent", sessionUrn: "urn:session:abc" },
      );

      expect(fetchMock).toHaveBeenCalled();
      expect(result).toEqual({ resultJson: '{"ok":true,"surface":"main"}' });
      vi.unstubAllGlobals();
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

      expect(toolRegistry.get("demo.set_message")).toBeUndefined();
      expect(toolRegistry.get("demo.get_message")).toBeUndefined();
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

    it("should remove HTTP proxy tools too", () => {
      const manifest = {
        name: "canvas-web",
        version: "1.0.0",
        tools: [
          {
            name: "canvas.push",
            description: "Push an A2UI surface",
            parameters: { type: "object", properties: {} },
            method: "POST" as const,
            path: "/api/a2ui/push",
          },
        ],
      };

      toolRegistry.registerServiceTools("demo", manifest);
      toolRegistry.deregisterServiceTools("demo");

      expect(toolRegistry.get("canvas.push")).toBeUndefined();
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

    it("should include HTTP proxy tools in listing", () => {
      const manifest = {
        name: "canvas-web",
        version: "1.0.0",
        tools: [
          {
            name: "canvas.push",
            description: "Push an A2UI surface",
            parameters: { type: "object", properties: {} },
            method: "POST" as const,
            path: "/api/a2ui/push",
          },
        ],
      };

      toolRegistry.registerServiceTools("demo", manifest);
      const list = toolRegistry.listTools();

      expect(list).toHaveLength(1);
      expect(list[0]).toEqual({
        qualifiedName: "canvas.push",
        serviceId: "demo",
        description: "Push an A2UI surface",
      });
    });
  });

  describe("get", () => {
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
      const decl = toolRegistry.get("demo.set_message");

      expect(decl).toBeDefined();
      expect(decl!.kind).toBe("direct");
      expect(decl!.serviceId).toBe("demo");
      expect(decl!.tool.name).toBe("demo.set_message");
      expect(decl!.tool.description).toBe("Set a message");
    });

    it("should return undefined for unknown tool", () => {
      const decl = toolRegistry.get("nonexistent.tool");
      expect(decl).toBeUndefined();
    });
  });
});
