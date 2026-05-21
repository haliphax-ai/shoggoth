import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import * as age from "age-encryption";
import { ServiceToolDispatcher } from "../src/service-tool-dispatcher";
import { ServiceRegistry } from "../src/service-registry";
import { ServiceKeyStore } from "../src/service-key-store";
import { TokenMinter, TokenValidator } from "../src/service-auth";
import { openStateDb } from "../src/db/open";
import { defaultMigrationsDir, migrate } from "../src/db/migrate";
import { closeTestDb } from "./helpers/close-test-db";

function openMigratedDb(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "shoggoth-dispatcher-"));
  const dbPath = join(dir, "test.db");
  const db = openStateDb(dbPath);
  migrate(db, defaultMigrationsDir());
  return { db, dir };
}

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

  describe("dispatch with TokenMinter", () => {
    let db: Database.Database;
    let tmpDir: string;
    let keyStore: ServiceKeyStore;
    let minter: TokenMinter;

    beforeEach(() => {
      const { db: database, dir } = openMigratedDb();
      db = database;
      tmpDir = dir;
      keyStore = new ServiceKeyStore(db);
      minter = new TokenMinter(keyStore);
    });

    afterEach(async () => {
      vi.unstubAllGlobals();
      await closeTestDb(db, tmpDir);
    });

    it("should use a real minted token when service has a stored recipient", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('{"ok":true}'),
      });
      vi.stubGlobal("fetch", fetchMock);

      await keyStore.generateIdentity("test-service");

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

      const dispatcherWithMinter = new ServiceToolDispatcher(serviceRegistry, minter);

      await dispatcherWithMinter.dispatch(
        "test-service",
        {
          name: "test.tool",
          description: "Test tool",
          parameters: {},
          method: "POST",
          path: "/api/test",
        },
        { data: "hello" },
        { agentId: "agent-1", sessionUrn: "urn:session:abc" },
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const callArgs = fetchMock.mock.calls[0];
      const headers = callArgs[1].headers as Record<string, string>;
      const authHeader = headers["Authorization"];

      // Should NOT be the placeholder
      expect(authHeader).not.toBe("Bearer shoggoth-placeholder");
      // Should be a Bearer token with base64url content
      expect(authHeader).toMatch(/^Bearer [A-Za-z0-9_-]+(=*)$/);
    });

    it("should fall back to placeholder token and log warning when service has no stored recipient", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('{"ok":true}'),
      });
      vi.stubGlobal("fetch", fetchMock);

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      // Do NOT generate an identity for this service — no stored recipient
      serviceRegistry.register({
        id: "no-key-service",
        label: "No Key Service",
        tier: "managed",
        url: "http://127.0.0.1:3000",
        healthy: true,
        capabilities: [],
        expose: "direct",
        manifest: null,
        registeredTools: [],
        approvalStatus: "approved",
      });

      const dispatcherWithMinter = new ServiceToolDispatcher(serviceRegistry, minter);

      await dispatcherWithMinter.dispatch(
        "no-key-service",
        {
          name: "test.tool",
          description: "Test tool",
          parameters: {},
          method: "POST",
          path: "/api/test",
        },
        {},
        { agentId: "agent-1", sessionUrn: "urn:session:abc" },
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const callArgs = fetchMock.mock.calls[0];
      const headers = callArgs[1].headers as Record<string, string>;
      const authHeader = headers["Authorization"];

      // Should fall back to placeholder
      expect(authHeader).toBe("Bearer shoggoth-placeholder");

      // Should have logged a warning
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("no-key-service"));

      warnSpy.mockRestore();
    });

    it("should set Authorization header to 'Bearer <base64url-encoded token>'", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('{"ok":true}'),
      });
      vi.stubGlobal("fetch", fetchMock);

      await keyStore.generateIdentity("test-service");

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

      const dispatcherWithMinter = new ServiceToolDispatcher(serviceRegistry, minter);

      await dispatcherWithMinter.dispatch(
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
      );

      const callArgs = fetchMock.mock.calls[0];
      const headers = callArgs[1].headers as Record<string, string>;
      const authHeader = headers["Authorization"];

      // Must start with "Bearer "
      expect(authHeader.startsWith("Bearer ")).toBe(true);

      // The token portion must be valid base64url
      const tokenPart = authHeader.slice("Bearer ".length);
      expect(tokenPart.length).toBeGreaterThan(0);
      // base64url characters only (A-Z, a-z, 0-9, -, _) with optional = padding
      expect(tokenPart).toMatch(/^[A-Za-z0-9_-]+(=*)$/);
    });

    it("should produce a minted token that can be validated with the service identity (round-trip)", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('{"ok":true}'),
      });
      vi.stubGlobal("fetch", fetchMock);

      // Generate identity outside the store so we have the private identity string
      const identity = await age.generateIdentity();
      const recipient = await age.identityToRecipient(identity);

      // Store the recipient in the key store manually
      db.prepare(
        "INSERT INTO service_keys (service_id, recipient, fingerprint) VALUES (?, ?, ?)",
      ).run("test-service", recipient, recipient.slice(0, 16));

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

      const dispatcherWithMinter = new ServiceToolDispatcher(serviceRegistry, minter);

      await dispatcherWithMinter.dispatch(
        "test-service",
        {
          name: "test.tool",
          description: "Test tool",
          parameters: {},
          method: "POST",
          path: "/api/test",
        },
        { action: "do-something" },
        { agentId: "agent-1", sessionUrn: "urn:session:test-123" },
      );

      const callArgs = fetchMock.mock.calls[0];
      const headers = callArgs[1].headers as Record<string, string>;
      const authHeader = headers["Authorization"];
      const tokenPart = authHeader.slice("Bearer ".length);

      // Validate the token using the service's identity (private key)
      const payload = await TokenValidator.validate(tokenPart, identity);
      expect(payload).not.toBeNull();
      expect(payload!.sub).toBe("agent-1");
      expect(payload!.scope).toBe("test-service");
      expect(payload!.session).toBe("urn:session:test-123");
      expect(payload!.exp - payload!.iat).toBe(300);
    });
  });
});
