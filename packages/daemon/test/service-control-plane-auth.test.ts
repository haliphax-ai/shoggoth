import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import * as age from "age-encryption";
import { ServiceKeyStore } from "../src/service-key-store";
import { TokenMinter, TokenValidator } from "../src/service-auth";
import { openStateDb } from "../src/db/open";
import { defaultMigrationsDir, migrate } from "../src/db/migrate";
import { closeTestDb } from "./helpers/close-test-db";

function openMigratedDb(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "shoggoth-svc-cp-auth-"));
  const dbPath = join(dir, "test.db");
  const db = openStateDb(dbPath);
  migrate(db, defaultMigrationsDir());
  return { db, dir };
}

describe("service-control-plane-auth (scoped access)", () => {
  let db: Database.Database;
  let tmpDir: string;
  let keyStore: ServiceKeyStore;
  let minter: TokenMinter;
  let serviceIdentity: string;
  let serviceRecipient: string;

  beforeEach(async () => {
    const { db: database, dir } = openMigratedDb();
    db = database;
    tmpDir = dir;
    keyStore = new ServiceKeyStore(db);
    minter = new TokenMinter(keyStore);

    // Generate a controlled identity for the test service
    serviceIdentity = await age.generateIdentity();
    serviceRecipient = await age.identityToRecipient(serviceIdentity);
  });

  afterEach(async () => {
    await closeTestDb(db, tmpDir);
  });

  describe("service authenticates via age-encrypted challenge token", () => {
    it("service can authenticate by decrypting a challenge token minted for it", async () => {
      // Store the recipient for the service
      await keyStore.generateIdentity("auth-service");
      // Override with our controlled recipient
      db.prepare("UPDATE service_keys SET recipient = ? WHERE service_id = ?").run(
        serviceRecipient,
        "auth-service",
      );

      const token = await minter.mint("agent-1", "auth-service");
      const payload = await TokenValidator.validate(token, serviceIdentity);

      expect(payload).not.toBeNull();
      expect(payload!.sub).toBe("agent-1");
      expect(payload!.scope).toBe("service");
    });

    it("service authenticates with session context in the token", async () => {
      await keyStore.generateIdentity("auth-service-session");
      db.prepare("UPDATE service_keys SET recipient = ? WHERE service_id = ?").run(
        serviceRecipient,
        "auth-service-session",
      );

      const sessionUrn = "urn:session:test-session-123";
      const token = await minter.mint("agent-1", "auth-service-session", sessionUrn);
      const payload = await TokenValidator.validate(token, serviceIdentity);

      expect(payload).not.toBeNull();
      expect(payload!.session).toBe(sessionUrn);
    });
  });

  describe("authentication fails with wrong identity", () => {
    it("returns null when service uses a different identity to decrypt", async () => {
      await keyStore.generateIdentity("wrong-id-service");
      db.prepare("UPDATE service_keys SET recipient = ? WHERE service_id = ?").run(
        serviceRecipient,
        "wrong-id-service",
      );

      const token = await minter.mint("agent-1", "wrong-id-service");

      // Attempt to validate with a completely different identity
      const wrongIdentity = await age.generateIdentity();
      const result = await TokenValidator.validate(token, wrongIdentity);

      expect(result).toBeNull();
    });

    it("returns null for tampered token data", async () => {
      await keyStore.generateIdentity("tamper-service");
      db.prepare("UPDATE service_keys SET recipient = ? WHERE service_id = ?").run(
        serviceRecipient,
        "tamper-service",
      );

      const token = await minter.mint("agent-1", "tamper-service");
      // Tamper with the token
      const tampered = token.slice(0, -5) + "XXXXX";
      const result = await TokenValidator.validate(tampered, serviceIdentity);

      expect(result).toBeNull();
    });
  });

  describe("isAuthorized returns true for approved ops", () => {
    it("returns true when the requested op is in the service manifest ops[]", async () => {
      // Import the module under test (RED phase — may not exist yet)
      let ServiceControlPlaneAuth: any;
      try {
        const mod = await import("../src/service-control-plane-auth");
        ServiceControlPlaneAuth = mod.ServiceControlPlaneAuth;
      } catch {
        // Module doesn't exist yet — expected in RED phase
        expect.fail("ServiceControlPlaneAuth module not found — implementation needed");
        return;
      }

      const auth = new ServiceControlPlaneAuth(db);

      // Store approval with ops
      const approvedOps = ["session.query", "session.list", "agent.ping"];
      auth.storeApprovedOps("svc-ops-test", approvedOps);

      expect(auth.isAuthorized("svc-ops-test", "session.query")).toBe(true);
      expect(auth.isAuthorized("svc-ops-test", "session.list")).toBe(true);
      expect(auth.isAuthorized("svc-ops-test", "agent.ping")).toBe(true);
    });
  });

  describe("isAuthorized returns false for undeclared ops", () => {
    it("returns false when the requested op is NOT in the service manifest ops[]", async () => {
      let ServiceControlPlaneAuth: any;
      try {
        const mod = await import("../src/service-control-plane-auth");
        ServiceControlPlaneAuth = mod.ServiceControlPlaneAuth;
      } catch {
        expect.fail("ServiceControlPlaneAuth module not found — implementation needed");
        return;
      }

      const auth = new ServiceControlPlaneAuth(db);

      // Store approval with limited ops
      const approvedOps = ["session.query"];
      auth.storeApprovedOps("svc-limited", approvedOps);

      expect(auth.isAuthorized("svc-limited", "session.query")).toBe(true);
      expect(auth.isAuthorized("svc-limited", "service.approve")).toBe(false);
      expect(auth.isAuthorized("svc-limited", "admin.shutdown")).toBe(false);
    });

    it("returns false for a service with empty ops[]", async () => {
      let ServiceControlPlaneAuth: any;
      try {
        const mod = await import("../src/service-control-plane-auth");
        ServiceControlPlaneAuth = mod.ServiceControlPlaneAuth;
      } catch {
        expect.fail("ServiceControlPlaneAuth module not found — implementation needed");
        return;
      }

      const auth = new ServiceControlPlaneAuth(db);
      auth.storeApprovedOps("svc-no-ops", []);

      expect(auth.isAuthorized("svc-no-ops", "session.query")).toBe(false);
      expect(auth.isAuthorized("svc-no-ops", "anything")).toBe(false);
    });
  });

  describe("revoked service cannot authenticate", () => {
    it("isAuthorized returns false for a revoked service regardless of ops", async () => {
      let ServiceControlPlaneAuth: any;
      try {
        const mod = await import("../src/service-control-plane-auth");
        ServiceControlPlaneAuth = mod.ServiceControlPlaneAuth;
      } catch {
        expect.fail("ServiceControlPlaneAuth module not found — implementation needed");
        return;
      }

      const auth = new ServiceControlPlaneAuth(db);

      // Store ops then revoke
      auth.storeApprovedOps("svc-revoked", ["session.query", "session.list"]);
      auth.revokeService("svc-revoked");

      expect(auth.isAuthorized("svc-revoked", "session.query")).toBe(false);
      expect(auth.isAuthorized("svc-revoked", "session.list")).toBe(false);
    });

    it("token validation succeeds but authorization check rejects revoked service", async () => {
      let ServiceControlPlaneAuth: any;
      try {
        const mod = await import("../src/service-control-plane-auth");
        ServiceControlPlaneAuth = mod.ServiceControlPlaneAuth;
      } catch {
        expect.fail("ServiceControlPlaneAuth module not found — implementation needed");
        return;
      }

      const auth = new ServiceControlPlaneAuth(db);

      // Service was approved with ops, then revoked
      auth.storeApprovedOps("svc-revoked-2", ["session.query"]);
      auth.revokeService("svc-revoked-2");

      // Even though the token might decrypt fine, the service is revoked
      expect(auth.isAuthorized("svc-revoked-2", "session.query")).toBe(false);
    });
  });

  describe("ops[] field in manifest is stored on approval", () => {
    it("stores ops from manifest when service is approved", async () => {
      let ServiceControlPlaneAuth: any;
      try {
        const mod = await import("../src/service-control-plane-auth");
        ServiceControlPlaneAuth = mod.ServiceControlPlaneAuth;
      } catch {
        expect.fail("ServiceControlPlaneAuth module not found — implementation needed");
        return;
      }

      const auth = new ServiceControlPlaneAuth(db);

      const manifest = {
        name: "test-service",
        version: "1.0.0",
        tools: [],
        ops: ["session.query", "session.send", "agent.ping"],
      };

      auth.approveWithManifest("svc-manifest", manifest);

      // All declared ops should be authorized
      expect(auth.isAuthorized("svc-manifest", "session.query")).toBe(true);
      expect(auth.isAuthorized("svc-manifest", "session.send")).toBe(true);
      expect(auth.isAuthorized("svc-manifest", "agent.ping")).toBe(true);
      // Undeclared ops should not be authorized
      expect(auth.isAuthorized("svc-manifest", "admin.shutdown")).toBe(false);
    });

    it("stores empty ops when manifest has no ops field", async () => {
      let ServiceControlPlaneAuth: any;
      try {
        const mod = await import("../src/service-control-plane-auth");
        ServiceControlPlaneAuth = mod.ServiceControlPlaneAuth;
      } catch {
        expect.fail("ServiceControlPlaneAuth module not found — implementation needed");
        return;
      }

      const auth = new ServiceControlPlaneAuth(db);

      const manifest = {
        name: "no-ops-service",
        version: "1.0.0",
        tools: [],
        // no ops field
      };

      auth.approveWithManifest("svc-no-manifest-ops", manifest);

      expect(auth.isAuthorized("svc-no-manifest-ops", "session.query")).toBe(false);
    });

    it("retrieves stored ops for an approved service", async () => {
      let ServiceControlPlaneAuth: any;
      try {
        const mod = await import("../src/service-control-plane-auth");
        ServiceControlPlaneAuth = mod.ServiceControlPlaneAuth;
      } catch {
        expect.fail("ServiceControlPlaneAuth module not found — implementation needed");
        return;
      }

      const auth = new ServiceControlPlaneAuth(db);

      const ops = ["session.query", "session.list"];
      auth.storeApprovedOps("svc-retrieve", ops);

      const stored = auth.getApprovedOps("svc-retrieve");
      expect(stored).toEqual(ops);
    });
  });

  describe("rate limiting: exceeding limit returns error", () => {
    it("allows requests within the rate limit", async () => {
      let ServiceControlPlaneAuth: any;
      try {
        const mod = await import("../src/service-control-plane-auth");
        ServiceControlPlaneAuth = mod.ServiceControlPlaneAuth;
      } catch {
        expect.fail("ServiceControlPlaneAuth module not found — implementation needed");
        return;
      }

      const auth = new ServiceControlPlaneAuth(db, { maxRequestsPerMinute: 10 });
      auth.storeApprovedOps("svc-rate", ["session.query"]);

      // First few requests should succeed
      for (let i = 0; i < 5; i++) {
        const result = auth.checkRateLimit("svc-rate");
        expect(result.allowed).toBe(true);
      }
    });

    it("rejects requests exceeding the rate limit", async () => {
      let ServiceControlPlaneAuth: any;
      try {
        const mod = await import("../src/service-control-plane-auth");
        ServiceControlPlaneAuth = mod.ServiceControlPlaneAuth;
      } catch {
        expect.fail("ServiceControlPlaneAuth module not found — implementation needed");
        return;
      }

      const auth = new ServiceControlPlaneAuth(db, { maxRequestsPerMinute: 5 });
      auth.storeApprovedOps("svc-rate-exceed", ["session.query"]);

      // Exhaust the rate limit
      for (let i = 0; i < 5; i++) {
        const result = auth.checkRateLimit("svc-rate-exceed");
        expect(result.allowed).toBe(true);
      }

      // Next request should be rejected
      const result = auth.checkRateLimit("svc-rate-exceed");
      expect(result.allowed).toBe(false);
      expect(result.error).toMatch(/rate limit exceeded/i);
    });

    it("rate limit resets after the window expires", async () => {
      let ServiceControlPlaneAuth: any;
      try {
        const mod = await import("../src/service-control-plane-auth");
        ServiceControlPlaneAuth = mod.ServiceControlPlaneAuth;
      } catch {
        expect.fail("ServiceControlPlaneAuth module not found — implementation needed");
        return;
      }

      const auth = new ServiceControlPlaneAuth(db, {
        maxRequestsPerMinute: 3,
        windowMs: 100, // 100ms window for testing
      });
      auth.storeApprovedOps("svc-rate-reset", ["session.query"]);

      // Exhaust the limit
      for (let i = 0; i < 3; i++) {
        auth.checkRateLimit("svc-rate-reset");
      }

      // Should be rejected
      expect(auth.checkRateLimit("svc-rate-reset").allowed).toBe(false);

      // Wait for window to expire
      await new Promise((r) => setTimeout(r, 150));

      // Should be allowed again
      expect(auth.checkRateLimit("svc-rate-reset").allowed).toBe(true);
    });
  });
});
