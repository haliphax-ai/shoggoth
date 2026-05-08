import { describe, it, vi, beforeEach, expect } from "vitest";
import assert from "node:assert";
import {
  BuiltinToolRegistry,
  type BuiltinToolContext,
} from "../../../src/sessions/builtin-tool-registry";
import { register } from "../../../src/sessions/builtin-handlers/vault-handler";
import { parseAgentSessionUrn } from "@shoggoth/shared";
import type { VaultService } from "../../../src/vault/vault-service";
import { createSecretFifo } from "../../../src/vault/fifo-proxy";

// Mock the fifo-proxy module
vi.mock("../../../src/vault/fifo-proxy.js", () => ({
  createSecretFifo: vi.fn(),
}));

// Mock vault service for testing
interface MockVaultService extends VaultService {
  put: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  resolve: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  listScopes: ReturnType<typeof vi.fn>;
  rotateKey: ReturnType<typeof vi.fn>;
  injectFifo?: ReturnType<typeof vi.fn>;
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

// Extended context type with vault and agentId
interface VaultToolContext extends BuiltinToolContext {
  vault: MockVaultService;
  agentId: string;
  creds: { uid: number; gid: number };
}

function stubCtx(overrides: Partial<VaultToolContext> = {}): VaultToolContext {
  const sessionId = overrides.sessionId ?? "agent:test:discord:channel:123";
  const parsed = parseAgentSessionUrn(sessionId);
  const agentId = parsed?.agentId ?? "test";

  return {
    sessionId,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    config: {} as any,
    env: {},
    workspacePath: "/tmp",
    creds: { uid: 1000, gid: 1000 },
    orchestratorEnv: {},
    getAgentIntegrationInvoker: () => undefined,
    getProcessManager: () => undefined,
    messageToolCtx: undefined,
    memoryConfig: { paths: [], embeddings: { enabled: false } },
    runtimeOpenaiBaseUrl: undefined,
    isSubagentSession: false,
    vault: createMockVaultService(),
    agentId,
    ...overrides,
  };
}

// -----------------------------------------------------------------------------
// vault inject
// -----------------------------------------------------------------------------

describe("builtin-vault inject", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves credential and returns FIFO path", async () => {
    const reg = new BuiltinToolRegistry();
    register(reg);

    const mockVault = createMockVaultService();
    mockVault.resolve.mockResolvedValue("secret-value-from-vault");

    const mockFifoPath = "/tmp/.vault/test-fifo-123";
    (createSecretFifo as ReturnType<typeof vi.fn>).mockResolvedValue(mockFifoPath);

    const ctx = stubCtx({
      sessionId: "agent:developer:discord:channel:123",
      vault: mockVault,
      agentId: "developer",
      creds: { uid: 1000, gid: 1000 },
    });

    const result = await reg.execute(
      "builtin-vault",
      { action: "inject", name: "API_KEY" },
      ctx,
    );
    const parsed = JSON.parse(result.resultJson);

    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.name, "API_KEY");
    assert.strictEqual(parsed.path, mockFifoPath);
    assert.ok(parsed.hint);

    // Verify resolve was called with agentId and name
    expect(mockVault.resolve).toHaveBeenCalledWith("developer", "API_KEY");

    // Verify createSecretFifo was called with the secret and credentials
    expect(createSecretFifo).toHaveBeenCalledWith(
      "secret-value-from-vault",
      1000, // uid
      1000, // gid
      undefined, // timeoutMs (default)
    );
  });

  it("resolves credential using scope precedence (agent scope first, then global)", async () => {
    const reg = new BuiltinToolRegistry();
    register(reg);

    const mockVault = createMockVaultService();
    // Agent scope returns null, falls back to global
    mockVault.resolve.mockResolvedValue(null);
    mockVault.get.mockResolvedValue("secret-from-global");

    const mockFifoPath = "/tmp/.vault/global-fifo-456";
    (createSecretFifo as ReturnType<typeof vi.fn>).mockResolvedValue(mockFifoPath);

    const ctx = stubCtx({
      sessionId: "agent:developer:discord:channel:123",
      vault: mockVault,
      agentId: "developer",
      creds: { uid: 1000, gid: 1000 },
    });

    const result = await reg.execute(
      "builtin-vault",
      { action: "inject", name: "DATABASE_URL" },
      ctx,
    );
    const parsed = JSON.parse(result.resultJson);

    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.path, mockFifoPath);

    // Verify resolve was called first
    expect(mockVault.resolve).toHaveBeenCalledWith("developer", "DATABASE_URL");

    // Since resolve returned null, should fall back to get with global
    expect(mockVault.get).toHaveBeenCalledWith("global", "DATABASE_URL");
  });

  it("fails if credential not found in any scope", async () => {
    const reg = new BuiltinToolRegistry();
    register(reg);

    const mockVault = createMockVaultService();
    mockVault.resolve.mockResolvedValue(null);
    mockVault.get.mockResolvedValue(null);

    const ctx = stubCtx({
      sessionId: "agent:developer:discord:channel:123",
      vault: mockVault,
      agentId: "developer",
      creds: { uid: 1000, gid: 1000 },
    });

    const result = await reg.execute(
      "builtin-vault",
      { action: "inject", name: "NONEXISTENT" },
      ctx,
    );
    const parsed = JSON.parse(result.resultJson);

    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.exists, false);
    assert.strictEqual(parsed.path, undefined);

    // Verify createSecretFifo was NOT called
    expect(createSecretFifo).not.toHaveBeenCalled();
  });

  it("returns error when name is missing", async () => {
    const reg = new BuiltinToolRegistry();
    register(reg);

    const ctx = stubCtx();

    const result = await reg.execute("builtin-vault", { action: "inject" }, ctx);
    const parsed = JSON.parse(result.resultJson);

    assert.strictEqual(parsed.error, "name is required");
  });

  it("passes custom timeout to createSecretFifo", async () => {
    const reg = new BuiltinToolRegistry();
    register(reg);

    const mockVault = createMockVaultService();
    mockVault.resolve.mockResolvedValue("secret-with-timeout");

    const mockFifoPath = "/tmp/.vault/timeout-fifo-789";
    (createSecretFifo as ReturnType<typeof vi.fn>).mockResolvedValue(mockFifoPath);

    const ctx = stubCtx({
      sessionId: "agent:developer:discord:channel:123",
      vault: mockVault,
      agentId: "developer",
      creds: { uid: 1000, gid: 1000 },
    });

    const result = await reg.execute(
      "builtin-vault",
      { action: "inject", name: "API_KEY", timeoutMs: 60000 },
      ctx,
    );
    const parsed = JSON.parse(result.resultJson);

    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.path, mockFifoPath);

    // Verify createSecretFifo was called with custom timeout
    expect(createSecretFifo).toHaveBeenCalledWith(
      "secret-with-timeout",
      1000,
      1000,
      60000,
    );
  });

  it("uses agent's UID/GID from context creds", async () => {
    const reg = new BuiltinToolRegistry();
    register(reg);

    const mockVault = createMockVaultService();
    mockVault.resolve.mockResolvedValue("secret-value");

    const mockFifoPath = "/tmp/.vault/creds-fifo";
    (createSecretFifo as ReturnType<typeof vi.fn>).mockResolvedValue(mockFifoPath);

    const ctx = stubCtx({
      sessionId: "agent:developer:discord:channel:123",
      vault: mockVault,
      agentId: "developer",
      creds: { uid: 900, gid: 900 }, // Agent UID/GID
    });

    await reg.execute(
      "builtin-vault",
      { action: "inject", name: "API_KEY" },
      ctx,
    );

    // Verify createSecretFifo was called with agent's UID/GID
    expect(createSecretFifo).toHaveBeenCalledWith(
      "secret-value",
      900,
      900,
      undefined,
    );
  });
});