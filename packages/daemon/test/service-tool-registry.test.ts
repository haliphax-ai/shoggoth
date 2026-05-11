/**
 * Service Tool Registry Tests
 *
 * Tests dynamic tool registration, deregistration, lookup, listing, and invocation.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { ServiceToolRegistry } from "../src/service-tool-registry";
import { ServiceRegistry, ServiceEntry } from "../src/service-registry";
import { ServiceToolDispatcher } from "../src/service-tool-dispatcher";
import type { ServiceManifest } from "@shoggoth/shared";

describe("ServiceToolRegistry", () => {
  let registry: ServiceToolRegistry;
  let serviceRegistry: ServiceRegistry;
  let dispatcher: ServiceToolDispatcher;
  let mockServiceEntry: ServiceEntry;

  const testManifest: ServiceManifest = {
    name: "test-service",
    version: "1.0.0",
    tools: [
      {
        name: "users.get",
        description: "Get a user by ID",
        parameters: { type: "object", properties: { id: { type: "string" } } },
        method: "GET",
        path: "/api/users/{id}",
        dispatch: "path",
      },
      {
        name: "users.list",
        description: "List all users",
        parameters: { type: "object", properties: {} },
        method: "GET",
        path: "/api/users",
        dispatch: "query",
      },
    ],
  };

  beforeEach(() => {
    serviceRegistry = new ServiceRegistry();
    dispatcher = {
      dispatch: vi.fn().mockResolvedValue({ resultJson: '{"ok":true}' }),
    } as unknown as ServiceToolDispatcher;

    mockServiceEntry = {
      id: "my-service",
      label: "My Service",
      url: "http://localhost:9000",
      healthy: true,
      capabilities: ["tools"],
      expose: "direct",
      manifest: null,
      registeredTools: [],
    };

    serviceRegistry.register(mockServiceEntry);
    registry = new ServiceToolRegistry(serviceRegistry, dispatcher);
  });

  it("registerServiceTools registers tools with namespaced names", () => {
    const registered = registry.registerServiceTools("my-service", testManifest);

    expect(registered).toEqual(["my-service.users.get", "my-service.users.list"]);
  });

  it("registerServiceTools updates the ServiceEntry registeredTools array", () => {
    registry.registerServiceTools("my-service", testManifest);

    const entry = serviceRegistry.get("my-service");
    expect(entry!.registeredTools).toEqual(["my-service.users.get", "my-service.users.list"]);
  });

  it("deregisterServiceTools removes all tools for a service", () => {
    registry.registerServiceTools("my-service", testManifest);
    registry.deregisterServiceTools("my-service");

    expect(registry.getToolDeclaration("my-service.users.get")).toBeUndefined();
    expect(registry.getToolDeclaration("my-service.users.list")).toBeUndefined();
    expect(registry.listTools()).toHaveLength(0);
  });

  it("deregisterServiceTools clears the ServiceEntry registeredTools array", () => {
    registry.registerServiceTools("my-service", testManifest);
    registry.deregisterServiceTools("my-service");

    const entry = serviceRegistry.get("my-service");
    expect(entry!.registeredTools).toEqual([]);
  });

  it("getToolDeclaration returns correct declaration", () => {
    registry.registerServiceTools("my-service", testManifest);

    const result = registry.getToolDeclaration("my-service.users.get");
    expect(result).toBeDefined();
    expect(result!.serviceId).toBe("my-service");
    expect(result!.toolDecl.name).toBe("users.get");
    expect(result!.toolDecl.description).toBe("Get a user by ID");
    expect(result!.toolDecl.method).toBe("GET");
    expect(result!.toolDecl.path).toBe("/api/users/{id}");
    expect(result!.toolDecl.dispatch).toBe("path");
  });

  it("getToolDeclaration returns undefined for unknown tool", () => {
    expect(registry.getToolDeclaration("nonexistent.tool")).toBeUndefined();
  });

  it("listTools returns all registered tools", () => {
    registry.registerServiceTools("my-service", testManifest);

    const tools = registry.listTools();
    expect(tools).toHaveLength(2);
    expect(tools).toEqual(
      expect.arrayContaining([
        {
          qualifiedName: "my-service.users.get",
          serviceId: "my-service",
          description: "Get a user by ID",
        },
        {
          qualifiedName: "my-service.users.list",
          serviceId: "my-service",
          description: "List all users",
        },
      ]),
    );
  });

  it("invokeTool dispatches to correct service", async () => {
    registry.registerServiceTools("my-service", testManifest);

    const result = await registry.invokeTool(
      "my-service.users.get",
      { id: "user-42" },
      { agentId: "agent-1", sessionUrn: "session:xyz" },
    );

    expect(result).toEqual({ resultJson: '{"ok":true}' });
    expect(dispatcher.dispatch).toHaveBeenCalledWith(
      testManifest.tools![0],
      { id: "user-42" },
      {
        agentId: "agent-1",
        sessionUrn: "session:xyz",
        serviceEntry: mockServiceEntry,
      },
    );
  });

  it("invokeTool throws for unknown tool", async () => {
    await expect(
      registry.invokeTool("unknown.tool", {}, { agentId: "agent-1", sessionUrn: "session:xyz" }),
    ).rejects.toThrow("Unknown tool: unknown.tool");
  });

  it("invokeTool throws when service is not found in registry", async () => {
    registry.registerServiceTools("my-service", testManifest);
    // Remove the service from the registry
    serviceRegistry.deregister("my-service");

    await expect(
      registry.invokeTool(
        "my-service.users.get",
        { id: "user-42" },
        { agentId: "agent-1", sessionUrn: "session:xyz" },
      ),
    ).rejects.toThrow("Service not found: my-service");
  });

  it("registerServiceTools handles manifest with no tools", () => {
    const emptyManifest: ServiceManifest = {
      name: "empty-service",
      version: "1.0.0",
    };

    const registered = registry.registerServiceTools("my-service", emptyManifest);
    expect(registered).toEqual([]);
  });
});
