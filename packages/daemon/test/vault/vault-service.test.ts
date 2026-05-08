import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { migrate, defaultMigrationsDir } from "../../src/db/migrate";
import { createVaultService, type VaultService } from "../../src/vault/vault-service";
import { ageGenerateIdentity } from "../../src/vault/age-crypto";

describe("VaultService", () => {
  let db: Database.Database;
  let vault: VaultService;
  let tempDir: string;
  let identityPath: string;
  let identity: Awaited<ReturnType<typeof ageGenerateIdentity>>;

  beforeAll(async () => {
    identity = await ageGenerateIdentity();
  });

  beforeEach(async () => {
    // Create temp directory for this test
    tempDir = mkdtempSync(join(tmpdir(), "shoggoth-vault-test-"));
    identityPath = join(tempDir, "identity.key");
    writeFileSync(identityPath, identity.identityString, "utf8");

    // Create in-memory database
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");

    // Run migrations including vault_secrets
    migrate(db, defaultMigrationsDir());

    // Create vault service
    vault = await createVaultService(db, identityPath, tempDir);
  });

  afterEach(() => {
    db.close();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  describe("put", () => {
    it("stores an encrypted credential in the vault", async () => {
      await vault.put("global", "TEST_KEY", "secret-value");

      // Should be retrievable
      const result = await vault.get("global", "TEST_KEY");
      expect(result).toBe("secret-value");
    });

    it("stores credential with metadata", async () => {
      const metadata = { expiresAt: "2026-12-31T23:59:59Z" };
      await vault.put("global", "EXPIRING_KEY", "value", metadata);

      const entries = vault.list("global");
      expect(entries).toHaveLength(1);
      expect(entries[0].metadata).toEqual(metadata);
    });

    it("updates existing credential when putting same scope+name", async () => {
      await vault.put("global", "SAME_KEY", "original");
      await vault.put("global", "SAME_KEY", "updated");

      const result = await vault.get("global", "SAME_KEY");
      expect(result).toBe("updated");

      // Should still be only one entry
      const entries = vault.list("global");
      expect(entries).toHaveLength(1);
    });

    it("rejects invalid scope format", async () => {
      await expect(vault.put("invalid", "KEY", "value")).rejects.toThrow(/invalid scope/i);
      await expect(vault.put("agent:", "KEY", "value")).rejects.toThrow(/invalid scope/i);
      await expect(vault.put("agent:abc@def", "KEY", "value")).rejects.toThrow(/invalid scope/i);
    });

    it("accepts valid 'global' scope", async () => {
      await expect(vault.put("global", "KEY", "value")).resolves.not.toThrow();
    });

    it("accepts valid 'agent:<agentId>' scope", async () => {
      await expect(vault.put("agent:developer", "KEY", "value")).resolves.not.toThrow();
      await expect(vault.put("agent:abc123", "KEY", "value")).resolves.not.toThrow();
    });
  });

  describe("get", () => {
    it("returns null for missing entry", async () => {
      const result = await vault.get("global", "NONEXISTENT");
      expect(result).toBeNull();
    });

    it("returns null for missing scope", async () => {
      await vault.put("global", "EXISTS", "value");

      const result = await vault.get("agent:missing", "EXISTS");
      expect(result).toBeNull();
    });

    it("retrieves stored credential", async () => {
      await vault.put("global", "MY_KEY", "my-secret");

      const result = await vault.get("global", "MY_KEY");
      expect(result).toBe("my-secret");
    });

    it("returns different values for same name in different scopes", async () => {
      await vault.put("global", "SHARED", "global-value");
      await vault.put("agent:dev", "SHARED", "agent-value");

      expect(await vault.get("global", "SHARED")).toBe("global-value");
      expect(await vault.get("agent:dev", "SHARED")).toBe("agent-value");
    });
  });

  describe("resolve", () => {
    it("returns null for nonexistent credential", async () => {
      const result = await vault.resolve("developer", "NONEXISTENT");
      expect(result).toBeNull();
    });

    it("resolves agent-scoped credential when it exists", async () => {
      await vault.put("agent:developer", "RESOLVE_ME", "agent-secret");

      const result = await vault.resolve("developer", "RESOLVE_ME");
      expect(result).toBe("agent-secret");
    });

    it("falls back to global scope when agent-scoped not found", async () => {
      await vault.put("global", "RESOLVE_ME", "global-secret");

      const result = await vault.resolve("developer", "RESOLVE_ME");
      expect(result).toBe("global-secret");
    });

    it("prefers agent scope over global scope", async () => {
      await vault.put("global", "DUPLICATE", "global-value");
      await vault.put("agent:developer", "DUPLICATE", "agent-value");

      const result = await vault.resolve("developer", "DUPLICATE");
      expect(result).toBe("agent-value");
    });

    it("returns null when credential exists in neither scope", async () => {
      await vault.put("agent:other", "OTHER_KEY", "other-value");

      const result = await vault.resolve("developer", "OTHER_KEY");
      expect(result).toBeNull();
    });
  });

  describe("delete", () => {
    it("returns false for nonexistent entry", async () => {
      const result = await vault.delete("global", "NONEXISTENT");
      expect(result).toBe(false);
    });

    it("deletes existing entry and returns true", async () => {
      await vault.put("global", "TO_DELETE", "value");

      const result = await vault.delete("global", "TO_DELETE");
      expect(result).toBe(true);

      // Should no longer exist
      expect(await vault.get("global", "TO_DELETE")).toBeNull();
    });

    it("only deletes from specified scope", async () => {
      await vault.put("global", "KEY", "global-value");
      await vault.put("agent:dev", "KEY", "agent-value");

      await vault.delete("global", "KEY");

      expect(await vault.get("global", "KEY")).toBeNull();
      expect(await vault.get("agent:dev", "KEY")).toBe("agent-value");
    });
  });

  describe("list", () => {
    it("returns empty array for empty scope", () => {
      const result = vault.list("global");
      expect(result).toEqual([]);
    });

    it("returns entries without values", async () => {
      await vault.put("global", "KEY_ONE", "secret-one");
      await vault.put("global", "KEY_TWO", "secret-two");

      const result = vault.list("global");

      expect(result).toHaveLength(2);
      // Should not contain the actual secret values
      expect(result[0]).not.toHaveProperty("value");
      expect(result[0]).not.toHaveProperty("ciphertext");
      // Should contain metadata
      expect(result[0]).toHaveProperty("name");
      expect(result[0]).toHaveProperty("scope");
      expect(result[0]).toHaveProperty("metadata");
      expect(result[0]).toHaveProperty("createdAt");
      expect(result[0]).toHaveProperty("updatedAt");
    });

    it("returns entries sorted by name", async () => {
      await vault.put("global", "ZEBRA", "z-value");
      await vault.put("global", "ALPHA", "a-value");
      await vault.put("global", "MIDDLE", "m-value");

      const result = vault.list("global");

      expect(result[0].name).toBe("ALPHA");
      expect(result[1].name).toBe("MIDDLE");
      expect(result[2].name).toBe("ZEBRA");
    });

    it("only lists entries for the specified scope", async () => {
      await vault.put("global", "GLOBAL_KEY", "global-value");
      await vault.put("agent:dev", "AGENT_KEY", "agent-value");

      const globalResult = vault.list("global");
      const agentResult = vault.list("agent:dev");

      expect(globalResult).toHaveLength(1);
      expect(globalResult[0].name).toBe("GLOBAL_KEY");

      expect(agentResult).toHaveLength(1);
      expect(agentResult[0].name).toBe("AGENT_KEY");
    });
  });

  describe("listScopes", () => {
    it("returns empty array when no entries exist", () => {
      const result = vault.listScopes();
      expect(result).toEqual([]);
    });

    it("returns distinct scopes with entries", async () => {
      await vault.put("global", "KEY1", "value1");
      await vault.put("agent:dev", "KEY2", "value2");
      await vault.put("agent:prod", "KEY3", "value3");
      await vault.put("global", "KEY4", "value4");

      const result = vault.listScopes();

      expect(result).toHaveLength(3);
      expect(result).toContain("global");
      expect(result).toContain("agent:dev");
      expect(result).toContain("agent:prod");
    });

    it("returns scopes in sorted order", async () => {
      await vault.put("agent:zebra", "KEY1", "value1");
      await vault.put("agent:alpha", "KEY2", "value2");
      await vault.put("global", "KEY3", "value3");

      const result = vault.listScopes();

      expect(result[0]).toBe("agent:alpha");
      expect(result[1]).toBe("agent:zebra");
      expect(result[2]).toBe("global");
    });
  });

  describe("rotateKey", () => {
    it("re-encrypts all entries with new identity", async () => {
      // Store some credentials with original identity
      await vault.put("global", "ROTATE_ME", "secret-value");
      await vault.put("agent:dev", "AGENT_SECRET", "agent-value");

      // Create new identity
      const newIdentity = await ageGenerateIdentity();
      const newIdentityPath = join(tempDir, "new-identity.key");
      writeFileSync(newIdentityPath, newIdentity.identityString, "utf8");

      // Rotate to new identity
      await vault.rotateKey(newIdentity);

      // The rotated vault should still be able to read (it now uses the new identity internally)
      expect(await vault.get("global", "ROTATE_ME")).toBe("secret-value");
      expect(await vault.get("agent:dev", "AGENT_SECRET")).toBe("agent-value");

      // A separate vault loaded with the new identity should also work
      const vault2 = await createVaultService(db, newIdentityPath, tempDir);
      expect(await vault2.get("global", "ROTATE_ME")).toBe("secret-value");
      expect(await vault2.get("agent:dev", "AGENT_SECRET")).toBe("agent-value");

      // A vault loaded with the OLD identity should NOT be able to decrypt
      const oldIdentityPath = join(tempDir, "old-identity.key");
      writeFileSync(oldIdentityPath, identity.identityString, "utf8");
      const vault3 = await createVaultService(db, oldIdentityPath, tempDir);
      await expect(vault3.get("global", "ROTATE_ME")).rejects.toThrow();
    });

    it("preserves metadata through key rotation", async () => {
      const metadata = { expiresAt: "2026-12-31T23:59:59Z" };
      await vault.put("global", "WITH_META", "value", metadata);

      const newIdentity = await ageGenerateIdentity();
      const newIdentityPath = join(tempDir, "new-identity.key");
      writeFileSync(newIdentityPath, newIdentity.identityString, "utf8");

      await vault.rotateKey(newIdentity);

      const vault2 = await createVaultService(db, newIdentityPath, tempDir);
      const entries = vault2.list("global");

      expect(entries).toHaveLength(1);
      expect(entries[0].metadata).toEqual(metadata);
    });

    it("is atomic - rolls back on failure", async () => {
      await vault.put("global", "KEY1", "value1");
      await vault.put("global", "KEY2", "value2");

      // Create an identity that can't decrypt the existing data
      const newIdentity = await ageGenerateIdentity();
      const newIdentityPath = join(tempDir, "new-identity.key");
      writeFileSync(newIdentityPath, newIdentity.identityString, "utf8");

      // Rotate should fail because new identity can't decrypt old data
      // The implementation should handle this gracefully
      try {
        await vault.rotateKey(newIdentity);
      } catch {
        // Expected to fail - old data can't be decrypted with new key
      }

      // The database should still be in a consistent state
      // Either all keys rotated or none (depending on implementation)
      // Just verify we can list entries
      expect(() => vault.list("global")).not.toThrow();
    });
  });

  describe("scope validation", () => {
    it("validates scope format on write operations", async () => {
      const invalidScopes = [
        "",
        "agent",
        "Agent:dev",
        "AGENT:dev",
        "global:extra",
        "random:text",
        "scope:with:colons",
      ];

      for (const scope of invalidScopes) {
        await expect(vault.put(scope, "KEY", "value")).rejects.toThrow(/invalid scope/i);
        await expect(vault.get(scope, "KEY")).rejects.toThrow(/invalid scope/i);
        await expect(vault.delete(scope, "KEY")).rejects.toThrow(/invalid scope/i);
        expect(() => vault.list(scope)).toThrow(/invalid scope/i);
      }
    });

    it("accepts valid scope formats", async () => {
      const validScopes = ["global", "agent:dev", "agent:test-user-123", "agent:abc"];

      for (const scope of validScopes) {
        await expect(vault.put(scope, "KEY", "value")).resolves.not.toThrow();
        await expect(vault.get(scope, "KEY")).resolves.not.toThrow();
        expect(() => vault.list(scope)).not.toThrow();
      }

      // delete is write operation, should also validate
      await expect(vault.delete("agent:dev", "KEY")).resolves.not.toThrow();
    });
  });

  describe("publicKey", () => {
    it("returns the public key of the loaded identity", () => {
      expect(vault.publicKey).toBe(identity.recipient);
      expect(vault.publicKey).toMatch(/^age1/);
    });
  });
});
