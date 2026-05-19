import { describe, it, expect, beforeEach, vi } from "vitest";
import { ServiceToolDispatcher } from "../src/service-tool-dispatcher";
import { ServiceRegistry } from "../src/service-registry";

describe("ServiceToolDispatcher", () => {
  let serviceRegistry: ServiceRegistry;
  let dispatcher: ServiceToolDispatcher;

  beforeEach(() => {
    serviceRegistry = new ServiceRegistry();
    dispatcher = new ServiceToolDispatcher(serviceRegistry);
  });

  describe("dispatch", () => {
    it("should throw if service is not found", async () => {
      await expect(
        dispatcher.dispatch(
          "nonexistent",
          {
            name: "test.tool",
            description: "Test tool",
            parameters: {},
            method: "POST",
            path: "/api/test",
          },
          {},
          { agentId: "agent-1", sessionUrn: "urn:session:abc" },
        ),
      ).rejects.toThrow("Service not found: nonexistent");
    });

    it("should throw if service is unhealthy", async () => {
      serviceRegistry.register({
        id: "unhealthy-service",
        label: "Unhealthy Service",
        tier: "managed",
        url: "http://127.0.0.1:3000",
        healthy: false,
        capabilities: [],
        expose: "direct",
        manifest: null,
        registeredTools: [],
        approvalStatus: "approved",
      });

      await expect(
        dispatcher.dispatch(
          "unhealthy-service",
          {
            name: "test.tool",
            description: "Test tool",
            parameters: {},
            method: "POST",
            path: "/api/test",
          },
          {},
          { agentId: "agent-1", sessionUrn: "urn:session:abc" },
        ),
      ).rejects.toThrow("Service unhealthy-service is unhealthy");
    });

    it("should throw if service has no URL", async () => {
      serviceRegistry.register({
        id: "no-url-service",
        label: "No URL Service",
        tier: "plugin",
        url: null,
        healthy: true,
        capabilities: [],
        expose: "direct",
        manifest: null,
        registeredTools: [],
        approvalStatus: "approved",
      });

      await expect(
        dispatcher.dispatch(
          "no-url-service",
          {
            name: "test.tool",
            description: "Test tool",
            parameters: {},
            method: "POST",
            path: "/api/test",
          },
          {},
          { agentId: "agent-1", sessionUrn: "urn:session:abc" },
        ),
      ).rejects.toThrow("Service no-url-service has no URL");
    });

    it("should make a POST request with body for dispatch=body", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('{"ok":true}'),
      });
      vi.stubGlobal("fetch", fetchMock);

      serviceRegistry.register({
        id: "test-service",
        label: "Test Service",
        tier: "managed",
        url: "http://127.0.0.1:3000",
        healthy: true,
        capabilities: [],
        expose: "direct",
        manifest: null,
        registeredTools: [],
        approvalStatus: "approved",
      });

      const result = await dispatcher.dispatch(
        "test-service",
        {
          name: "test.tool",
          description: "Test tool",
          parameters: {},
          method: "POST",
          path: "/api/test",
          dispatch: "body",
        },
        { message: "hello" },
        { agentId: "agent-1", sessionUrn: "urn:session:abc" },
      );

      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:3000/api/test",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ message: "hello" }),
          headers: expect.objectContaining({
            "Content-Type": "application/json",
            Authorization: "Bearer shoggoth-placeholder",
          }),
        }),
      );

      expect(result).toEqual({ resultJson: '{"ok":true}' });
      vi.unstubAllGlobals();
    });

    it("should make a GET request with query params for dispatch=query", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('{"ok":true}'),
      });
      vi.stubGlobal("fetch", fetchMock);

      serviceRegistry.register({
        id: "test-service",
        label: "Test Service",
        tier: "managed",
        url: "http://127.0.0.1:3000",
        healthy: true,
        capabilities: [],
        expose: "direct",
        manifest: null,
        registeredTools: [],
        approvalStatus: "approved",
      });

      const result = await dispatcher.dispatch(
        "test-service",
        {
          name: "test.query",
          description: "Query tool",
          parameters: {},
          method: "GET",
          path: "/api/query",
          dispatch: "query",
        },
        { id: "123", format: "json" },
        { agentId: "agent-1", sessionUrn: "urn:session:abc" },
      );

      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:3000/api/query?id=123&format=json",
        expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({
            Authorization: "Bearer shoggoth-placeholder",
          }),
        }),
      );

      expect(result).toEqual({ resultJson: '{"ok":true}' });
      vi.unstubAllGlobals();
    });

    it("should make a request with path params for dispatch=path", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('{"ok":true}'),
      });
      vi.stubGlobal("fetch", fetchMock);

      serviceRegistry.register({
        id: "test-service",
        label: "Test Service",
        tier: "managed",
        url: "http://127.0.0.1:3000",
        healthy: true,
        capabilities: [],
        expose: "direct",
        manifest: null,
        registeredTools: [],
        approvalStatus: "approved",
      });

      const result = await dispatcher.dispatch(
        "test-service",
        {
          name: "test.get",
          description: "Get tool",
          parameters: {},
          method: "GET",
          path: "/api/users/{userId}/posts/{postId}",
          dispatch: "path",
        },
        { userId: "abc", postId: "123" },
        { agentId: "agent-1", sessionUrn: "urn:session:abc" },
      );

      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:3000/api/users/abc/posts/123",
        expect.objectContaining({
          method: "GET",
        }),
      );

      expect(result).toEqual({ resultJson: '{"ok":true}' });
      vi.unstubAllGlobals();
    });

    it("should handle non-2xx responses gracefully", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: "Not Found",
        text: () => Promise.resolve("Resource not found"),
      });
      vi.stubGlobal("fetch", fetchMock);

      serviceRegistry.register({
        id: "test-service",
        label: "Test Service",
        tier: "managed",
        url: "http://127.0.0.1:3000",
        healthy: true,
        capabilities: [],
        expose: "direct",
        manifest: null,
        registeredTools: [],
        approvalStatus: "approved",
      });

      const result = await dispatcher.dispatch(
        "test-service",
        {
          name: "test.tool",
          description: "Test tool",
          parameters: {},
          method: "GET",
          path: "/api/notfound",
        },
        {},
        { agentId: "agent-1", sessionUrn: "urn:session:abc" },
      );

      expect(result).toEqual({
        resultJson: JSON.stringify({
          error: true,
          status: 404,
          statusText: "Not Found",
          message: "Resource not found",
        }),
      });
      vi.unstubAllGlobals();
    });

    it("should handle network errors", async () => {
      const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
      vi.stubGlobal("fetch", fetchMock);

      serviceRegistry.register({
        id: "test-service",
        label: "Test Service",
        tier: "managed",
        url: "http://127.0.0.1:3000",
        healthy: true,
        capabilities: [],
        expose: "direct",
        manifest: null,
        registeredTools: [],
        approvalStatus: "approved",
      });

      await expect(
        dispatcher.dispatch(
          "test-service",
          {
            name: "test.tool",
            description: "Test tool",
            parameters: {},
            method: "POST",
            path: "/api/test",
          },
          {},
          { agentId: "agent-1", sessionUrn: "urn:session:abc" },
        ),
      ).rejects.toThrow("Failed to dispatch tool to test-service: ECONNREFUSED");
      vi.unstubAllGlobals();
    });

    it("should use default dispatch=body when not specified", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('{"ok":true}'),
      });
      vi.stubGlobal("fetch", fetchMock);

      serviceRegistry.register({
        id: "test-service",
        label: "Test Service",
        tier: "managed",
        url: "http://127.0.0.1:3000",
        healthy: true,
        capabilities: [],
        expose: "direct",
        manifest: null,
        registeredTools: [],
        approvalStatus: "approved",
      });

      await dispatcher.dispatch(
        "test-service",
        {
          name: "test.tool",
          description: "Test tool",
          parameters: {},
          method: "POST",
          path: "/api/test",
          // dispatch not specified - should default to body
        },
        { data: "test" },
        { agentId: "agent-1", sessionUrn: "urn:session:abc" },
      );

      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:3000/api/test",
        expect.objectContaining({
          body: JSON.stringify({ data: "test" }),
        }),
      );
      vi.unstubAllGlobals();
    });

    it("should include all HTTP methods", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('{"ok":true}'),
      });
      vi.stubGlobal("fetch", fetchMock);

      serviceRegistry.register({
        id: "test-service",
        label: "Test Service",
        tier: "managed",
        url: "http://127.0.0.1:3000",
        healthy: true,
        capabilities: [],
        expose: "direct",
        manifest: null,
        registeredTools: [],
        approvalStatus: "approved",
      });

      const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

      for (const method of methods) {
        fetchMock.mockClear();

        await dispatcher.dispatch(
          "test-service",
          {
            name: "test.tool",
            description: "Test tool",
            parameters: {},
            method,
            path: "/api/test",
          },
          {},
          { agentId: "agent-1", sessionUrn: "urn:session:abc" },
        );

        expect(fetchMock).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ method }),
        );
      }
      vi.unstubAllGlobals();
    });
  });
});
