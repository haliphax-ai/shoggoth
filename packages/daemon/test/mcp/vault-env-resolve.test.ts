import { describe, it, vi, expect, beforeEach } from "vitest";
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

    const result = await resolveVaultEnv({ API_KEY: "$vault:API_KEY" }, mockVault, "developer");

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

    expect(result).toEqual({
      PLAIN_VAR: "plain-value",
      ANOTHER: "also-plain",
    });
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

  it("passes through $vault:NAME literal when credential not found", async () => {
    mockVault.resolve.mockResolvedValue(null);

    const result = await resolveVaultEnv(
      { MISSING_CRED: "$vault:MISSING_CRED", PLAIN_VAR: "plain" },
      mockVault,
      "developer",
    );

    expect(result).toEqual({
      MISSING_CRED: "$vault:MISSING_CRED",
      PLAIN_VAR: "plain",
    });
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

  it("does not resolve ambiguous partial matches", async () => {
    mockVault.resolve.mockResolvedValue("secret");

    const result = await resolveVaultEnv(
      {
        PARTIAL_SUFFIX: "$vault:API_KEYsuffix",
        PARTIAL_BOTH: "pre$vault:API_KEYpost",
        END_OF_STRING: "prefix$vault:API_KEY",
      },
      mockVault,
      "developer",
    );

    expect(result.PARTIAL_SUFFIX).toBe("$vault:API_KEYsuffix");
    expect(result.PARTIAL_BOTH).toBe("pre$vault:API_KEYpost");
    expect(result.END_OF_STRING).toBe("prefixsecret");
    expect(mockVault.resolve).toHaveBeenCalledTimes(1);
    expect(mockVault.resolve).toHaveBeenCalledWith("developer", "API_KEY");
  });

  it("uses agent scope precedence via vault.resolve()", async () => {
    mockVault.resolve.mockResolvedValue("agent-scoped-secret");

    const result = await resolveVaultEnv({ CRED: "$vault:CRED" }, mockVault, "developer-agent-123");

    expect(result.CRED).toBe("agent-scoped-secret");
    expect(mockVault.resolve).toHaveBeenCalledWith("developer-agent-123", "CRED");
  });

  it("handles empty env map", async () => {
    const result = await resolveVaultEnv({}, mockVault, "developer");

    expect(result).toEqual({});
    expect(mockVault.resolve).not.toHaveBeenCalled();
  });

  it("passes through all $vault:NAME literals when none are found", async () => {
    mockVault.resolve.mockResolvedValue(null);

    const result = await resolveVaultEnv(
      { CRED1: "$vault:MISSING_1", CRED2: "$vault:MISSING_2" },
      mockVault,
      "developer",
    );

    expect(result).toEqual({
      CRED1: "$vault:MISSING_1",
      CRED2: "$vault:MISSING_2",
    });
  });

  // ---------------------------------------------------------------------------
  // Inline $vault:<name> substring resolution
  // ---------------------------------------------------------------------------

  it("resolves $vault:NAME as an inline substring in a larger string", async () => {
    mockVault.resolve.mockResolvedValue("tk_abc123");

    const result = await resolveVaultEnv(
      { API_HEADERS: "Authorization:Bearer $vault:API_KEY" },
      mockVault,
      "developer",
    );

    expect(result).toEqual({
      API_HEADERS: "Authorization:Bearer tk_abc123",
    });
    expect(mockVault.resolve).toHaveBeenCalledWith("developer", "API_KEY");
  });

  it("resolves multiple $vault: references in a single env var value", async () => {
    mockVault.resolve.mockResolvedValueOnce("example.com").mockResolvedValueOnce("8443");

    const result = await resolveVaultEnv(
      { ENDPOINT: "$vault:HOST:$vault:PORT" },
      mockVault,
      "developer",
    );

    expect(result).toEqual({
      ENDPOINT: "example.com:8443",
    });
    expect(mockVault.resolve).toHaveBeenCalledTimes(2);
    expect(mockVault.resolve).toHaveBeenCalledWith("developer", "HOST");
    expect(mockVault.resolve).toHaveBeenCalledWith("developer", "PORT");
  });

  it("does not match $vault: followed by invalid credential name", async () => {
    const result = await resolveVaultEnv(
      { NO_MATCH: "partial $vault: match" },
      mockVault,
      "developer",
    );

    expect(result).toEqual({ NO_MATCH: "partial $vault: match" });
    expect(mockVault.resolve).not.toHaveBeenCalled();
  });

  it("leaves unresolved $vault: literal in place when inline credential not found", async () => {
    mockVault.resolve.mockResolvedValueOnce("example.com").mockResolvedValueOnce(null);

    const result = await resolveVaultEnv(
      { ENDPOINT: "$vault:HOST:$vault:PORT" },
      mockVault,
      "developer",
    );

    expect(result).toEqual({ ENDPOINT: "example.com:$vault:PORT" });
  });

  it("still works as full-value $vault:NAME (backward compatible)", async () => {
    mockVault.resolve.mockResolvedValue("full-secret");

    const result = await resolveVaultEnv({ SECRET: "$vault:MY_SECRET" }, mockVault, "developer");

    expect(result).toEqual({ SECRET: "full-secret" });
    expect(mockVault.resolve).toHaveBeenCalledWith("developer", "MY_SECRET");
  });

  it("resolves multiple different vault names in one value without duplicate lookups", async () => {
    mockVault.resolve.mockResolvedValueOnce("user123").mockResolvedValueOnce("pass456");

    const result = await resolveVaultEnv(
      { CONN: "user=$vault:DB_USER pass=$vault:DB_PASS" },
      mockVault,
      "developer",
    );

    expect(result).toEqual({
      CONN: "user=user123 pass=pass456",
    });
    expect(mockVault.resolve).toHaveBeenCalledTimes(2);
  });

  it("reuses cached resolution for duplicate credential names in one value", async () => {
    mockVault.resolve.mockResolvedValue("shared-secret");

    const result = await resolveVaultEnv(
      { BOTH: "$vault:SHARED:$vault:SHARED" },
      mockVault,
      "developer",
    );

    expect(result).toEqual({ BOTH: "shared-secret:shared-secret" });
    expect(mockVault.resolve).toHaveBeenCalledTimes(1);
    expect(mockVault.resolve).toHaveBeenCalledWith("developer", "SHARED");
  });

  it("passes through $vault:NAME literal when full-value credential is not found", async () => {
    mockVault.resolve.mockResolvedValue(null);

    const result = await resolveVaultEnv({ MISSING: "$vault:NOPE" }, mockVault, "developer");

    expect(result).toEqual({ MISSING: "$vault:NOPE" });
  });

  it("does not resolve $vault:NAMEsuffix where suffix is lowercase", async () => {
    const result = await resolveVaultEnv({ VAL: "$vault:API_KEYsuffix" }, mockVault, "developer");

    expect(result).toEqual({ VAL: "$vault:API_KEYsuffix" });
    expect(mockVault.resolve).not.toHaveBeenCalled();
  });

  it("resolves $vault:NAME at start of value followed by non-name characters", async () => {
    mockVault.resolve.mockResolvedValue("tok_999");

    const result = await resolveVaultEnv({ AUTH: "$vault:TOKEN " }, mockVault, "developer");

    expect(result).toEqual({ AUTH: "tok_999 " });
    expect(mockVault.resolve).toHaveBeenCalledWith("developer", "TOKEN");
  });

  it("resolves $vault: with all-lowercase credential name inline", async () => {
    mockVault.resolve.mockResolvedValue("lowercase-val");

    const result = await resolveVaultEnv(
      { URL: "https://$vault:host_name/path" },
      mockVault,
      "developer",
    );

    expect(result).toEqual({ URL: "https://lowercase-val/path" });
    expect(mockVault.resolve).toHaveBeenCalledWith("developer", "host_name");
  });
});
