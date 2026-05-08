import { describe, it, vi, expect, beforeEach } from "vitest";
import assert from "node:assert";
import {
  resolveVaultEnv,
  isVaultReference,
  extractVaultName,
} from "../../src/mcp/vault-env-resolve";
import type { VaultService } from "../../src/vault/vault-service";

// Mock vault service for testing
interface MockVaultService extends VaultService {
  put: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  resolve: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  listScopes: ReturnType<typeof vi.fn>;
  rotateKey: ReturnType<typeof vi.fn>;
}

function createMockVaultService(): MockVaultService {
  return {
    put: vi.fn(),
    get: vi.fn(),
    resolve: vi.fn(),
    delete: vi.fn(),
    list: vi.fn(),
    listScopes: vi.fn(),
    rotateKey: vi.fn(),
    publicKey: "age1test",
  };
}

// -----------------------------------------------------------------------------
// isVaultReference
// -----------------------------------------------------------------------------

describe("isVaultReference", () => {
  it("returns true for exact $vault:NAME pattern", () => {
    expect(isVaultReference("$vault:API_KEY")).toBe(true);
    expect(isVaultReference("$vault:GITHUB_TOKEN")).toBe(true);
    expect(isVaultReference("$vault:")).toBe(false); // empty name is not valid
  });

  it("returns false for non-vault strings", () => {
    expect(isVaultReference("plain-value")).toBe(false);
    expect(isVaultReference("$env:VAR")).toBe(false);
    expect(isVaultReference("prefix$vault:NAME")).toBe(false); // partial match
  });

  it("returns false for strings starting with $vault but not followed by name", () => {
    expect(isVaultReference("$vault:")).toBe(false);
    expect(isVaultReference("$vault")).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// extractVaultName
// -----------------------------------------------------------------------------

describe("extractVaultName", () => {
  it("extracts name from valid vault reference", () => {
    expect(extractVaultName("$vault:API_KEY")).toBe("API_KEY");
    expect(extractVaultName("$vault:GITHUB_TOKEN")).toBe("GITHUB_TOKEN");
    expect(extractVaultName("$vault:some-credential-name")).toBe("some-credential-name");
  });

  it("returns null for non-vault references", () => {
    expect(extractVaultName("plain-value")).toBe(null);
    expect(extractVaultName("$env:VAR")).toBe(null);
    expect(extractVaultName("prefix$vault:NAME")).toBe(null);
  });

  it("returns null for invalid vault reference patterns", () => {
    expect(extractVaultName("$vault:")).toBe(null);
    expect(extractVaultName("$vault")).toBe(null);
  });
});

// -----------------------------------------------------------------------------
// resolveVaultEnv
// -----------------------------------------------------------------------------

describe("resolveVaultEnv", () => {
  let mockVault: MockVaultService;

  beforeEach(() => {
    mockVault = createMockVaultService();
  });

  it("resolves $vault:NAME to the credential value", async () => {
    mockVault.resolve.mockResolvedValue("secret-from-vault");

    const result = await resolveVaultEnv(
      { API_KEY: "$vault:API_KEY" },
      mockVault,
      "developer",
    );

    expect(result).toEqual({ API_KEY: "secret-from-vault" });
    expect(mockVault.resolve).toHaveBeenCalledWith("developer", "API_KEY");
  });

  it("leaves non-vault env vars unchanged", async () => {
    mockVault.resolve.mockResolvedValue("secret-from-vault");

    const result = await resolveVaultEnv(
      { PLAIN_VAR: "plain-value", ANOTHER: "also-plain" },
      mockVault,
      "developer",
    );

    expect(result).toEqual({ PLAIN_VAR: "plain-value", ANOTHER: "also-plain" });
    expect(mockVault.resolve).not.toHaveBeenCalled();
  });

  it("handles mixed plain and vault env vars", async () => {
    mockVault.resolve.mockResolvedValue("secret-value");

    const result = await resolveVaultEnv(
      {
        PLAIN_VAR: "plain-value",
        SECURE_TOKEN: "$vault:SECURE_TOKEN",
        ANOTHER_PLAIN: "another-plain",
      },
      mockVault,
      "developer",
    );

    expect(result).toEqual({
      PLAIN_VAR: "plain-value",
      SECURE_TOKEN: "secret-value",
      ANOTHER_PLAIN: "another-plain",
    });
  });

  it("omits env var if vault credential not found (with warning)", async () => {
    mockVault.resolve.mockResolvedValue(null);

    const result = await resolveVaultEnv(
      { MISSING_CRED: "$vault:MISSING_CRED", PLAIN_VAR: "plain" },
      mockVault,
      "developer",
    );

    // The env var should be omitted when credential is not found
    expect(result).toEqual({ PLAIN_VAR: "plain" });
    expect(result.MISSING_CRED).toBeUndefined();
    expect(mockVault.resolve).toHaveBeenCalledWith("developer", "MISSING_CRED");
  });

  it("handles multiple vault references in the same env map", async () => {
    mockVault.resolve
      .mockResolvedValueOnce("token-value")
      .mockResolvedValueOnce("api-secret")
      .mockResolvedValueOnce("db-password");

    const result = await resolveVaultEnv(
      {
        GITHUB_TOKEN: "$vault:GITHUB_TOKEN",
        API_SECRET: "$vault:API_SECRET",
        DB_PASSWORD: "$vault:DB_PASSWORD",
        PLAIN_VAR: "plain",
      },
      mockVault,
      "developer",
    );

    expect(result).toEqual({
      GITHUB_TOKEN: "token-value",
      API_SECRET: "api-secret",
      DB_PASSWORD: "db-password",
      PLAIN_VAR: "plain",
    });
    expect(mockVault.resolve).toHaveBeenCalledTimes(3);
  });

  it("does not resolve partial matches (e.g., prefix$vault:NAME is left as-is)", async () => {
    mockVault.resolve.mockResolvedValue("secret");

    const result = await resolveVaultEnv(
      {
        // These should NOT be resolved (partial matches)
        PARTIAL_PREFIX: "prefix$vault:API_KEY",
        PARTIAL_SUFFIX: "$vault:API_KEYsuffix",
        PARTIAL_BOTH: "pre$vault:API_KEYpost",
        // This SHOULD be resolved (exact match)
        EXACT: "$vault:EXACT_KEY",
      },
      mockVault,
      "developer",
    );

    // Partial matches should remain unchanged
    expect(result.PARTIAL_PREFIX).toBe("prefix$vault:API_KEY");
    expect(result.PARTIAL_SUFFIX).toBe("$vault:API_KEYsuffix");
    expect(result.PARTIAL_BOTH).toBe("pre$vault:API_KEYpost");
    // Exact match should be resolved
    expect(result.EXACT).toBe("secret");
    // Only the exact match should have called resolve
    expect(mockVault.resolve).toHaveBeenCalledTimes(1);
    expect(mockVault.resolve).toHaveBeenCalledWith("developer", "EXACT_KEY");
  });

  it("uses agent scope precedence via vault.resolve()", async () => {
    // vault.resolve checks agent:<agentId> first, then global
    mockVault.resolve.mockResolvedValue("agent-scoped-secret");

    const result = await resolveVaultEnv(
      { CRED: "$vault:CRED" },
      mockVault,
      "developer-agent-123",
    );

    expect(result.CRED).toBe("agent-scoped-secret");
    expect(mockVault.resolve).toHaveBeenCalledWith("developer-agent-123", "CRED");
  });

  it("handles empty env map", async () => {
    const result = await resolveVaultEnv({}, mockVault, "developer");

    expect(result).toEqual({});
    expect(mockVault.resolve).not.toHaveBeenCalled();
  });

  it("handles env map with only vault references that are not found", async () => {
    mockVault.resolve.mockResolvedValue(null);

    const result = await resolveVaultEnv(
      { CRED1: "$vault:MISSING_1", CRED2: "$vault:MISSING_2" },
      mockVault,
      "developer",
    );

    // Both should be omitted
    expect(result).toEqual({});
  });
});