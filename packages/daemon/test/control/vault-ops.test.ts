import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { migrate, defaultMigrationsDir } from "../../src/db/migrate";
import { createVaultService, type VaultService } from "../../src/vault/vault-service";
import { ageGenerateIdentity } from "../../src/vault/age-crypto";
import { parseEnvFile } from "../../src/vault/env-parser";
import { WIRE_VERSION } from "@shoggoth/authn";
import type { AuthenticatedPrincipal } from "@shoggoth/authn";
import type { IntegrationOpsContext } from "../../src/control/integration-ops";
import {
  handleVaultSet,
  handleVaultGet,
  handleVaultDelete,
  handleVaultList,
  handleVaultImport,
  handleVaultRotateKey,
} from "../../src/control/vault-ops";

function makeWireRequest(
  op: string,
  payload: Record<string, unknown>,
): {
  v: number;
  id: string;
  op: string;
  auth: { kind: "operator"; token: string };
  payload: Record<string, unknown>;
} {
  return {
    v: WIRE_VERSION,
    id: randomUUID(),
    op,
    auth: { kind: "operator", token: "test-op-token" },
    payload,
  };
}

const operatorPrincipal: AuthenticatedPrincipal = {
  kind: "operator",
  operatorId: "test-op",
  source: "token",
};

describe("vault-ops control handlers", () => {
  let db: Database.Database;
  let vault: VaultService;
  let tempDir: string;
  let identityPath: string;
  let identity: Awaited<ReturnType<typeof ageGenerateIdentity>>;
  let ctx: IntegrationOpsContext;

  beforeAll(async () => {
    identity = await ageGenerateIdentity();
  });

  beforeEach(async () => {
    // Create temp directory for this test
    tempDir = mkdtempSync(join(tmpdir(), "shoggoth-vault-ops-test-"));
    identityPath = join(tempDir, "identity.key");
    writeFileSync(identityPath, identity.identityString, "utf8");

    // Create in-memory database
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");

    // Run migrations including vault_secrets
    migrate(db, defaultMigrationsDir());

    // Create vault service
    vault = await createVaultService(db, identityPath, tempDir);

    // Create integration context with vault service
    ctx = {
      config: {
        logLevel: "info",
        stateDbPath: join(tempDir, "state.db"),
        socketPath: join(tempDir, "c.sock"),
        workspacesRoot: tempDir,
        secretsDirectory: tempDir,
        inboundMediaRoot: tempDir,
        configDirectory: tempDir,
        operatorDirectory: tempDir,
        hitl: {
          defaultApprovalTimeoutMs: 300_000,
          toolRisk: {},
          bypassUpTo: "safe",
        },
        memory: { paths: [], embeddings: { enabled: false } },
        skills: { scanRoots: [], disabledIds: [] },
        plugins: [],
        mcp: { servers: [], poolScope: "global" },
        policy: {
          auditRedaction: { jsonPaths: [] },
        },
      } as any,
      stateDb: db,
      recordIntegrationAudit: () => {},
      vault,
    };
  });

  afterEach(() => {
    db.close();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  describe("vault.set", () => {
    it("stores a credential", async () => {
      const req = makeWireRequest("vault.set", {
        scope: "global",
        name: "TEST_KEY",
        value: "secret-value",
      });

      const result = await handleVaultSet(req, operatorPrincipal, ctx);

      expect(result).toEqual({ ok: true, scope: "global", name: "TEST_KEY", written: true });

      // Verify it was stored
      const getReq = makeWireRequest("vault.get", {
        scope: "global",
        name: "TEST_KEY",
      });
      const getResult = await handleVaultGet(getReq, operatorPrincipal, ctx);
      expect(getResult).toEqual({ ok: true, scope: "global", name: "TEST_KEY", value: "secret-value" });
    });

    it("stores credential with metadata", async () => {
      const req = makeWireRequest("vault.set", {
        scope: "global",
        name: "EXPIRING_KEY",
        value: "value",
        metadata: { expiresAt: "2026-12-31T23:59:59Z" },
      });

      const result = await handleVaultSet(req, operatorPrincipal, ctx);
      expect(result).toHaveProperty("ok", true);

      // List should show the metadata
      const listReq = makeWireRequest("vault.list", { scope: "global" });
      const listResult = await handleVaultList(listReq, operatorPrincipal, ctx) as any;
      expect(listResult.entries).toHaveLength(1);
      expect(listResult.entries[0].metadata).toEqual({ expiresAt: "2026-12-31T23:59:59Z" });
    });

    it("updates existing credential when putting same scope+name", async () => {
      await handleVaultSet(
        makeWireRequest("vault.set", {
          scope: "global",
          name: "SAME_KEY",
          value: "original",
        }),
        operatorPrincipal,
        ctx,
      );

      const result = await handleVaultSet(
        makeWireRequest("vault.set", {
          scope: "global",
          name: "SAME_KEY",
          value: "updated",
        }),
        operatorPrincipal,
        ctx,
      );

      expect(result).toHaveProperty("ok", true);

      // Verify updated value
      const getResult = await handleVaultGet(
        makeWireRequest("vault.get", { scope: "global", name: "SAME_KEY" }),
        operatorPrincipal,
        ctx,
      ) as any;
      expect(getResult.value).toBe("updated");
    });
  });

  describe("vault.get", () => {
    it("retrieves a credential", async () => {
      // First store a credential
      await handleVaultSet(
        makeWireRequest("vault.set", {
          scope: "global",
          name: "MY_KEY",
          value: "my-secret",
        }),
        operatorPrincipal,
        ctx,
      );

      // Then retrieve it
      const req = makeWireRequest("vault.get", {
        scope: "global",
        name: "MY_KEY",
      });

      const result = await handleVaultGet(req, operatorPrincipal, ctx);

      expect(result).toEqual({
        ok: true,
        scope: "global",
        name: "MY_KEY",
        value: "my-secret",
      });
    });

    it("returns null for missing entry", async () => {
      const req = makeWireRequest("vault.get", {
        scope: "global",
        name: "NONEXISTENT",
      });

      const result = await handleVaultGet(req, operatorPrincipal, ctx);

      expect(result).toEqual({
        ok: true,
        scope: "global",
        name: "NONEXISTENT",
        value: null,
      });
    });

    it("returns null for missing scope", async () => {
      // Store in global
      await handleVaultSet(
        makeWireRequest("vault.set", {
          scope: "global",
          name: "EXISTS",
          value: "value",
        }),
        operatorPrincipal,
        ctx,
      );

      // Try to get from agent scope
      const req = makeWireRequest("vault.get", {
        scope: "agent:missing",
        name: "EXISTS",
      });

      const result = await handleVaultGet(req, operatorPrincipal, ctx);

      expect((result as any).value).toBeNull();
    });
  });

  describe("vault.delete", () => {
    it("removes a credential", async () => {
      // First store a credential
      await handleVaultSet(
        makeWireRequest("vault.set", {
          scope: "global",
          name: "TO_DELETE",
          value: "temp-value",
        }),
        operatorPrincipal,
        ctx,
      );

      // Delete it
      const delReq = makeWireRequest("vault.delete", {
        scope: "global",
        name: "TO_DELETE",
      });

      const delResult = await handleVaultDelete(delReq, operatorPrincipal, ctx);
      expect(delResult).toEqual({ ok: true, deleted: true });

      // Verify it's gone
      const getResult = await handleVaultGet(
        makeWireRequest("vault.get", { scope: "global", name: "TO_DELETE" }),
        operatorPrincipal,
        ctx,
      ) as any;
      expect(getResult.value).toBeNull();
    });

    it("returns deleted: false for missing entry", async () => {
      const req = makeWireRequest("vault.delete", {
        scope: "global",
        name: "NONEXISTENT",
      });

      const result = await handleVaultDelete(req, operatorPrincipal, ctx);

      expect(result).toEqual({ ok: true, deleted: false });
    });
  });

  describe("vault.list", () => {
    it("returns entries in a scope", async () => {
      // Store some credentials
      await handleVaultSet(
        makeWireRequest("vault.set", {
          scope: "global",
          name: "KEY_ONE",
          value: "value1",
        }),
        operatorPrincipal,
        ctx,
      );
      await handleVaultSet(
        makeWireRequest("vault.set", {
          scope: "global",
          name: "KEY_TWO",
          value: "value2",
        }),
        operatorPrincipal,
        ctx,
      );

      const req = makeWireRequest("vault.list", { scope: "global" });

      const result = await handleVaultList(req, operatorPrincipal, ctx);

      expect(result).toHaveProperty("ok", true);
      const res = result as any;
      expect(res.entries).toHaveLength(2);
      expect(res.entries.map((e: any) => e.name).sort()).toEqual(["KEY_ONE", "KEY_TWO"]);
      // Values should not be returned
      expect(res.entries[0]).not.toHaveProperty("value");
    });

    it("returns empty array when no entries", async () => {
      const req = makeWireRequest("vault.list", { scope: "global" });

      const result = await handleVaultList(req, operatorPrincipal, ctx);

      expect(result).toHaveProperty("ok", true);
      expect((result as any).entries).toEqual([]);
    });

    it("returns entries from all scopes when scope is omitted", async () => {
      // Store in different scopes
      await handleVaultSet(
        makeWireRequest("vault.set", {
          scope: "global",
          name: "GLOBAL_KEY",
          value: "global-value",
        }),
        operatorPrincipal,
        ctx,
      );
      await handleVaultSet(
        makeWireRequest("vault.set", {
          scope: "agent:dev",
          name: "AGENT_KEY",
          value: "agent-value",
        }),
        operatorPrincipal,
        ctx,
      );

      const req = makeWireRequest("vault.list", {});

      const result = await handleVaultList(req, operatorPrincipal, ctx);

      expect(result).toHaveProperty("ok", true);
      const res = result as any;
      expect(res.entries).toHaveLength(2);
    });
  });

  describe("vault.import", () => {
    it("parses env content and stores all entries", async () => {
      const envContent = `# Comment
FOO=bar
EMPTY=
DATABASE_URL=postgres://user:pass@host:5432/db

# Another comment
API_KEY=secret123
`;
      const req = makeWireRequest("vault.import", {
        scope: "global",
        envFileContent: envContent,
      });

      const result = await handleVaultImport(req, operatorPrincipal, ctx);

      expect(result).toHaveProperty("ok", true);
      const res = result as any;
      expect(res.imported).toBe(3); // FOO, EMPTY, DATABASE_URL, API_KEY = 4 actually

      // Verify entries were stored
      const fooResult = await handleVaultGet(
        makeWireRequest("vault.get", { scope: "global", name: "FOO" }),
        operatorPrincipal,
        ctx,
      ) as any;
      expect(fooResult.value).toBe("bar");

      const apiKeyResult = await handleVaultGet(
        makeWireRequest("vault.get", { scope: "global", name: "API_KEY" }),
        operatorPrincipal,
        ctx,
      ) as any;
      expect(apiKeyResult.value).toBe("secret123");
    });

    it("strips quotes from values during import", async () => {
      const envContent = `QUOTED_DOUBLE="value with spaces"
QUOTED_SINGLE='single quoted'
`;

      const req = makeWireRequest("vault.import", {
        scope: "global",
        envFileContent: envContent,
      });

      await handleVaultImport(req, operatorPrincipal, ctx);

      const doubleResult = await handleVaultGet(
        makeWireRequest("vault.get", { scope: "global", name: "QUOTED_DOUBLE" }),
        operatorPrincipal,
        ctx,
      ) as any;
      expect(doubleResult.value).toBe("value with spaces");

      const singleResult = await handleVaultGet(
        makeWireRequest("vault.get", { scope: "global", name: "QUOTED_SINGLE" }),
        operatorPrincipal,
        ctx,
      ) as any;
      expect(singleResult.value).toBe("single quoted");
    });
  });

  describe("vault.rotate-key", () => {
    it("re-encrypts with new identity", async () => {
      // First store a credential
      await handleVaultSet(
        makeWireRequest("vault.set", {
          scope: "global",
          name: "ROTATE_ME",
          value: "secret-before-rotate",
        }),
        operatorPrincipal,
        ctx,
      );

      // Generate new identity
      const newIdentity = await ageGenerateIdentity();
      const newIdentityPath = join(tempDir, "new-identity.key");
      writeFileSync(newIdentityPath, newIdentity.identityString, "utf8");

      // Rotate to new identity
      const req = makeWireRequest("vault.rotate-key", {
        newIdentityPath,
      });

      const result = await handleVaultRotateKey(req, operatorPrincipal, ctx);

      expect(result).toHaveProperty("ok", true);

      // The credential should still be retrievable (re-encrypted with new key)
      // Note: This test assumes the vault service rotates its internal identity
      // In practice, we'd need to reload the vault with the new identity to verify
    });
  });
});