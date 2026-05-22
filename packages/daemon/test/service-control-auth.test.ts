import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { ServiceKeyStore } from "../src/service-key-store";
import { openStateDb } from "../src/db/open";
import { defaultMigrationsDir, migrate } from "../src/db/migrate";
import { closeTestDb } from "./helpers/close-test-db";
import type { WireRequest } from "@shoggoth/authn";
import type { AuthenticatedPrincipal } from "@shoggoth/authn";
import type { IntegrationOpsContext } from "../src/control/integration-ops";
import type { ServiceApprovalStore } from "../src/service-approval-store";
import type { ServiceRegistry } from "../src/service-registry";
import type { ServiceToolRegistry } from "../src/service-tool-registry";
import { serviceProvisionSecrets, tokenMinterRef } from "../src/service-refs";
import { TokenMinter } from "../src/service-auth";

import {
  handleServiceList,
  handleServiceApprove,
  handleServiceRevoke,
} from "../src/control/service-ops";

function openMigratedDb(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "shoggoth-svc-ctrl-auth-"));
  const dbPath = join(dir, "test.db");
  const db = openStateDb(dbPath);
  migrate(db, defaultMigrationsDir());
  return { db, dir };
}

describe("service-control-auth (key provisioning)", () => {
  let db: Database.Database;
  let tmpDir: string;
  let keyStore: ServiceKeyStore;
  let mockApprovalStore: ServiceApprovalStore;
  let mockServiceRegistry: ServiceRegistry;
  let mockToolRegistry: ServiceToolRegistry;
  let mockCtx: IntegrationOpsContext;
  let mockPrincipal: AuthenticatedPrincipal;

  beforeEach(() => {
    const { db: database, dir } = openMigratedDb();
    db = database;
    tmpDir = dir;
    keyStore = new ServiceKeyStore(db);

    mockApprovalStore = {
      get: vi.fn(),
      list: vi.fn().mockReturnValue([]),
      approve: vi.fn(),
      revoke: vi.fn(),
    } as unknown as ServiceApprovalStore;

    mockServiceRegistry = {
      get: vi.fn(),
      list: vi.fn().mockReturnValue([]),
      setApprovalStatus: vi.fn(),
    } as unknown as ServiceRegistry;

    mockToolRegistry = {
      listTools: vi.fn().mockReturnValue([]),
      deregisterServiceTools: vi.fn(),
    } as unknown as ServiceToolRegistry;

    mockCtx = {
      serviceApprovalStore: mockApprovalStore,
      serviceRegistry: mockServiceRegistry,
      serviceToolRegistry: mockToolRegistry,
      serviceKeyStore: keyStore,
    } as unknown as IntegrationOpsContext;

    mockPrincipal = { kind: "operator" as const, token: "test-token" };

    // Mock global fetch
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    serviceProvisionSecrets.clear();
    tokenMinterRef.current = undefined;
    await closeTestDb(db, tmpDir);
  });
  describe("service.approve key provisioning", () => {
    it("generates an age identity and stores recipient in ServiceKeyStore", async () => {
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

      // Mock fetch to succeed
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

      const req: WireRequest = {
        id: "test-approve-key-1",
        op: "service.approve",
        auth: { kind: "operator_token", token: "test" },
        payload: { service_id: "svc-1" },
      };

      const result = await handleServiceApprove(req, mockPrincipal, mockCtx);

      expect(result).toHaveProperty("ok", true);
      expect(result).toHaveProperty("service_id", "svc-1");

      // Verify key was stored in ServiceKeyStore
      const recipient = keyStore.getRecipient("svc-1");
      expect(recipient).not.toBeNull();
      expect(recipient).toMatch(/^age1/);

      // Verify fingerprint was stored
      const fingerprint = keyStore.getFingerprint("svc-1");
      expect(fingerprint).not.toBeNull();
      expect(fingerprint).toHaveLength(16);
    });

    it("delivers identity to service via POST {url}/_shoggoth/identity", async () => {
      vi.mocked(mockServiceRegistry.get).mockReturnValue({
        id: "svc-deliver",
        label: "Delivery Service",
        tier: "managed" as const,
        url: "http://localhost:9090",
        healthy: true,
        capabilities: [],
        expose: "gateway" as const,
        manifest: {
          name: "delivery-service",
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

      // Seed provision secret so delivery can authenticate
      serviceProvisionSecrets.set("svc-deliver", "deadbeef".repeat(8));

      // Mock fetch to succeed
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

      const req: WireRequest = {
        id: "test-approve-deliver",
        op: "service.approve",
        auth: { kind: "operator_token", token: "test" },
        payload: { service_id: "svc-deliver" },
      };

      await handleServiceApprove(req, mockPrincipal, mockCtx);

      // Verify fetch was called with the correct URL and method
      expect(fetch).toHaveBeenCalledWith(
        "http://localhost:9090/_shoggoth/identity",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
            "X-Provision-Secret": expect.any(String),
          }),
        }),
      );

      // Verify the X-Provision-Secret header is a non-empty hex string
      const fetchCall = vi.mocked(fetch).mock.calls[0];
      const headers = (fetchCall[1] as RequestInit).headers as Record<string, string>;
      expect(headers["X-Provision-Secret"]).toMatch(/^[0-9a-f]{64}$/);

      // Verify the body contains the identity string
      const body = JSON.parse((fetchCall[1] as RequestInit).body as string);
      expect(body).toHaveProperty("identity");
      expect(typeof body.identity).toBe("string");
      expect(body.identity.length).toBeGreaterThan(0);
    });

    it("falls back gracefully if service is unreachable (stores key, marks delivery pending)", async () => {
      vi.mocked(mockServiceRegistry.get).mockReturnValue({
        id: "svc-offline",
        label: "Offline Service",
        tier: "managed" as const,
        url: "http://unreachable:1234",
        healthy: false,
        capabilities: [],
        expose: "gateway" as const,
        manifest: {
          name: "offline-service",
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

      // Mock fetch to reject (network error)
      vi.mocked(fetch).mockRejectedValue(new Error("ECONNREFUSED"));

      const req: WireRequest = {
        id: "test-approve-offline",
        op: "service.approve",
        auth: { kind: "operator_token", token: "test" },
        payload: { service_id: "svc-offline" },
      };

      const result = await handleServiceApprove(req, mockPrincipal, mockCtx);

      // Should still succeed (approval stored)
      expect(result).toHaveProperty("ok", true);
      expect(result).toHaveProperty("service_id", "svc-offline");

      // Key should still be stored in ServiceKeyStore
      const recipient = keyStore.getRecipient("svc-offline");
      expect(recipient).not.toBeNull();
      expect(recipient).toMatch(/^age1/);

      // Result should indicate delivery is pending
      expect(result).toHaveProperty("delivery", "pending");
    });
  });

  describe("service.revoke key deletion", () => {
    it("deletes key material from ServiceKeyStore", async () => {
      // Pre-provision a key for the service
      await keyStore.generateIdentity("svc-revoke");
      expect(keyStore.hasIdentity("svc-revoke")).toBe(true);

      vi.mocked(mockServiceRegistry.get).mockReturnValue({
        id: "svc-revoke",
        label: "Revoke Service",
        tier: "managed" as const,
        url: "http://localhost:8080",
        healthy: true,
        capabilities: [],
        expose: "gateway" as const,
        manifest: null,
        registeredTools: [],
        approvalStatus: "approved" as const,
      });

      const req: WireRequest = {
        id: "test-revoke-key",
        op: "service.revoke",
        auth: { kind: "operator_token", token: "test" },
        payload: { service_id: "svc-revoke" },
      };

      const result = await handleServiceRevoke(req, mockPrincipal, mockCtx);

      expect(result).toHaveProperty("ok", true);

      // Key material should be deleted from ServiceKeyStore
      expect(keyStore.hasIdentity("svc-revoke")).toBe(false);
      expect(keyStore.getRecipient("svc-revoke")).toBeNull();
    });
  });

  describe("service.rotate-key", () => {
    it("generates new identity, delivers to service, old recipient replaced", async () => {
      // Pre-provision a key for the service
      const original = await keyStore.generateIdentity("svc-rotate");
      const originalRecipient = original.recipient;
      expect(keyStore.hasIdentity("svc-rotate")).toBe(true);

      vi.mocked(mockServiceRegistry.get).mockReturnValue({
        id: "svc-rotate",
        label: "Rotate Service",
        tier: "managed" as const,
        url: "http://localhost:7070",
        healthy: true,
        capabilities: [],
        expose: "gateway" as const,
        manifest: {
          name: "rotate-service",
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
        registeredTools: ["tool1"],
        approvalStatus: "approved" as const,
      });

      // Set up token minter so rotation can authenticate via Bearer token
      tokenMinterRef.current = new TokenMinter(keyStore);

      // Mock fetch to succeed for identity delivery
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

      const req: WireRequest = {
        id: "test-rotate-key",
        op: "service.rotate-key",
        auth: { kind: "operator_token", token: "test" },
        payload: { service_id: "svc-rotate" },
      };

      const { handleServiceRotateKey } = await import("../src/control/service-ops");

      const result = await handleServiceRotateKey(req, mockPrincipal, mockCtx);

      expect(result).toHaveProperty("ok", true);
      expect(result).toHaveProperty("service_id", "svc-rotate");

      // Old recipient should be replaced
      const newRecipient = keyStore.getRecipient("svc-rotate");
      expect(newRecipient).not.toBeNull();
      expect(newRecipient).toMatch(/^age1/);
      expect(newRecipient).not.toBe(originalRecipient);

      // Should have delivered new identity to service
      expect(fetch).toHaveBeenCalledWith(
        "http://localhost:7070/_shoggoth/identity",
        expect.objectContaining({
          method: "POST",
        }),
      );
    });
  });

  describe("service.list includes key_fingerprint", () => {
    it("includes key_fingerprint in response for services with keys", async () => {
      // Pre-provision a key
      await keyStore.generateIdentity("svc-listed");
      const fingerprint = keyStore.getFingerprint("svc-listed");

      vi.mocked(mockApprovalStore.list).mockReturnValue([
        {
          serviceId: "svc-listed",
          status: "approved" as const,
          approvedFingerprint: "manifest-fp",
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
        },
      ]);

      vi.mocked(mockServiceRegistry.list).mockReturnValue([
        {
          id: "svc-listed",
          label: "Listed Service",
          tier: "managed" as const,
          url: "http://localhost:8080",
          healthy: true,
          capabilities: ["cap1"],
          expose: "gateway" as const,
          manifest: null,
          registeredTools: [],
          approvalStatus: "approved" as const,
        },
      ]);

      const req: WireRequest = {
        id: "test-list-fingerprint",
        op: "service.list",
        auth: { kind: "operator_token", token: "test" },
        payload: {},
      };

      const result = await handleServiceList(req, mockPrincipal, mockCtx);

      expect(result).toHaveProperty("services");
      const services = (result as { services: Array<{ id: string; key_fingerprint?: string }> })
        .services;
      expect(services).toHaveLength(1);

      const svc = services.find((s) => s.id === "svc-listed");
      expect(svc).toBeDefined();
      expect(svc!.key_fingerprint).toBe(fingerprint);
    });
  });
});
