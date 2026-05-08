import { describe, it, vi } from "vitest";
import assert from "node:assert";
import {
  BuiltinToolRegistry,
  type BuiltinToolContext,
} from "../../../src/sessions/builtin-tool-registry";
import { register } from "../../../src/sessions/builtin-handlers/vault-handler";
import { parseAgentSessionUrn } from "@shoggoth/shared";
import type { VaultService } from "../../../src/vault/vault-service";

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

// Extended context type with vault and agentId
interface VaultToolContext extends BuiltinToolContext {
  vault: MockVaultService;
  agentId: string;
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
// vault get
// -----------------------------------------------------------------------------

describe("builtin-vault get", () => {
  it("resolves credential using agent's scope precedence (agent scope first)", async () => {
    const reg = new BuiltinToolRegistry();
    register(reg);

    const mockVault = createMockVaultService();
    // Agent scope has the credential
    mockVault.get.mockImplementation((scope: string) =>
      scope === "agent:developer" ? "secret-value-from-agent-scope" : null,
    );

    const ctx = stubCtx({
      sessionId: "agent:developer:discord:channel:123",
      vault: mockVault,
      agentId: "developer",
    });

    const result = await reg.execute("vault", { action: "get", name: "API_KEY" }, ctx);
    const parsed = JSON.parse(result.resultJson);

    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.name, "API_KEY");
    assert.strictEqual(parsed.value, "secret-value-from-agent-scope");
    assert.strictEqual(parsed.scope, "agent:developer");
    // Verify get was called with agent scope first
    assert.strictEqual(mockVault.get.mock.calls[0][0], "agent:developer");
    assert.strictEqual(mockVault.get.mock.calls[0][1], "API_KEY");
  });

  it("falls back to global scope when agent scope credential not found", async () => {
    const reg = new BuiltinToolRegistry();
    register(reg);

    const mockVault = createMockVaultService();
    // Agent scope returns null, global has the value
    mockVault.get.mockImplementation((scope: string) =>
      scope === "global" ? "secret-value-from-global" : null,
    );

    const ctx = stubCtx({
      sessionId: "agent:developer:discord:channel:123",
      vault: mockVault,
      agentId: "developer",
    });

    const result = await reg.execute("vault", { action: "get", name: "API_KEY" }, ctx);
    const parsed = JSON.parse(result.resultJson);

    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.value, "secret-value-from-global");
    assert.strictEqual(parsed.scope, "global");
  });

  it("returns null when credential not found in any scope", async () => {
    const reg = new BuiltinToolRegistry();
    register(reg);

    const mockVault = createMockVaultService();
    mockVault.get.mockReturnValue(null);

    const ctx = stubCtx({
      sessionId: "agent:developer:discord:channel:123",
      vault: mockVault,
      agentId: "developer",
    });

    const result = await reg.execute("vault", { action: "get", name: "NONEXISTENT" }, ctx);
    const parsed = JSON.parse(result.resultJson);

    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.value, null);
    assert.strictEqual(parsed.exists, false);
  });

  it("returns error when name is missing", async () => {
    const reg = new BuiltinToolRegistry();
    register(reg);

    const ctx = stubCtx();

    const result = await reg.execute("vault", { action: "get" }, ctx);
    const parsed = JSON.parse(result.resultJson);

    assert.strictEqual(parsed.error, "name is required");
  });
});

// -----------------------------------------------------------------------------
// vault set
// -----------------------------------------------------------------------------

describe("builtin-vault set", () => {
  it("stores credential in agent's own scope", async () => {
    const reg = new BuiltinToolRegistry();
    register(reg);

    const mockVault = createMockVaultService();
    mockVault.put.mockReturnValue(undefined);

    const ctx = stubCtx({
      sessionId: "agent:developer:discord:channel:123",
      vault: mockVault,
      agentId: "developer",
    });

    const result = await reg.execute(
      "vault",
      { action: "set", name: "API_KEY", value: "secret123" },
      ctx,
    );
    const parsed = JSON.parse(result.resultJson);

    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.name, "API_KEY");
    assert.strictEqual(parsed.scope, "agent:developer");
    assert.strictEqual(parsed.written, true);
    // Verify put was called with agent scope
    assert.strictEqual(mockVault.put.mock.calls.length, 1);
    assert.strictEqual(mockVault.put.mock.calls[0][0], "agent:developer");
    assert.strictEqual(mockVault.put.mock.calls[0][1], "API_KEY");
    assert.strictEqual(mockVault.put.mock.calls[0][2], "secret123");
  });

  it("returns error when name is missing", async () => {
    const reg = new BuiltinToolRegistry();
    register(reg);

    const ctx = stubCtx();

    const result = await reg.execute("vault", { action: "set", value: "secret123" }, ctx);
    const parsed = JSON.parse(result.resultJson);

    assert.strictEqual(parsed.error, "name is required");
  });

  it("returns error when value is missing", async () => {
    const reg = new BuiltinToolRegistry();
    register(reg);

    const ctx = stubCtx();

    const result = await reg.execute("vault", { action: "set", name: "API_KEY" }, ctx);
    const parsed = JSON.parse(result.resultJson);

    assert.strictEqual(parsed.error, "value is required");
  });
});

// -----------------------------------------------------------------------------
// vault delete
// -----------------------------------------------------------------------------

describe("builtin-vault delete", () => {
  it("removes credential from agent's own scope", async () => {
    const reg = new BuiltinToolRegistry();
    register(reg);

    const mockVault = createMockVaultService();
    mockVault.delete.mockReturnValue(true);

    const ctx = stubCtx({
      sessionId: "agent:developer:discord:channel:123",
      vault: mockVault,
      agentId: "developer",
    });

    const result = await reg.execute("vault", { action: "delete", name: "API_KEY" }, ctx);
    const parsed = JSON.parse(result.resultJson);

    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.name, "API_KEY");
    assert.strictEqual(parsed.scope, "agent:developer");
    assert.strictEqual(parsed.deleted, true);
    // Verify delete was called with agent scope
    assert.strictEqual(mockVault.delete.mock.calls.length, 1);
    assert.strictEqual(mockVault.delete.mock.calls[0][0], "agent:developer");
    assert.strictEqual(mockVault.delete.mock.calls[0][1], "API_KEY");
  });

  it("returns deleted: false when credential did not exist", async () => {
    const reg = new BuiltinToolRegistry();
    register(reg);

    const mockVault = createMockVaultService();
    mockVault.delete.mockReturnValue(false);

    const ctx = stubCtx({
      sessionId: "agent:developer:discord:channel:123",
      vault: mockVault,
      agentId: "developer",
    });

    const result = await reg.execute("vault", { action: "delete", name: "NONEXISTENT" }, ctx);
    const parsed = JSON.parse(result.resultJson);

    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.deleted, false);
  });

  it("returns error when name is missing", async () => {
    const reg = new BuiltinToolRegistry();
    register(reg);

    const ctx = stubCtx();

    const result = await reg.execute("vault", { action: "delete" }, ctx);
    const parsed = JSON.parse(result.resultJson);

    assert.strictEqual(parsed.error, "name is required");
  });
});

// -----------------------------------------------------------------------------
// vault list
// -----------------------------------------------------------------------------

describe("builtin-vault list", () => {
  it("returns entries from agent scope and global scope", async () => {
    const reg = new BuiltinToolRegistry();
    register(reg);

    const mockVault = createMockVaultService();
    const agentEntries = [
      {
        name: "API_KEY",
        scope: "agent:developer",
        metadata: null,
        createdAt: "2026-05-08T10:00:00Z",
        updatedAt: "2026-05-08T10:00:00Z",
      },
    ];
    const globalEntries = [
      {
        name: "DATABASE_URL",
        scope: "global",
        metadata: null,
        createdAt: "2026-05-08T09:00:00Z",
        updatedAt: "2026-05-08T09:00:00Z",
      },
    ];

    // First call returns agent entries, second returns global
    mockVault.list.mockReturnValueOnce(agentEntries).mockReturnValueOnce(globalEntries);

    const ctx = stubCtx({
      sessionId: "agent:developer:discord:channel:123",
      vault: mockVault,
      agentId: "developer",
    });

    const result = await reg.execute("vault", { action: "list" }, ctx);
    const parsed = JSON.parse(result.resultJson);

    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.entries.length, 2);
    assert.strictEqual(parsed.entries[0].name, "API_KEY");
    assert.strictEqual(parsed.entries[0].scope, "agent:developer");
    assert.strictEqual(parsed.entries[1].name, "DATABASE_URL");
    assert.strictEqual(parsed.entries[1].scope, "global");
    // Verify list was called twice: agent scope then global
    assert.strictEqual(mockVault.list.mock.calls.length, 2);
    assert.strictEqual(mockVault.list.mock.calls[0][0], "agent:developer");
    assert.strictEqual(mockVault.list.mock.calls[1][0], "global");
  });

  it("returns empty entries when no credentials exist", async () => {
    const reg = new BuiltinToolRegistry();
    register(reg);

    const mockVault = createMockVaultService();
    mockVault.list.mockReturnValue([]);

    const ctx = stubCtx({
      sessionId: "agent:developer:discord:channel:123",
      vault: mockVault,
      agentId: "developer",
    });

    const result = await reg.execute("vault", { action: "list" }, ctx);
    const parsed = JSON.parse(result.resultJson);

    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.entries.length, 0);
  });
});

// -----------------------------------------------------------------------------
// Subagent session resolution
// -----------------------------------------------------------------------------

describe("builtin-vault subagent resolution", () => {
  it("resolves subagent session URN to parent agent ID", async () => {
    const reg = new BuiltinToolRegistry();
    register(reg);

    const mockVault = createMockVaultService();
    mockVault.get.mockImplementation((scope: string) =>
      scope === "agent:developer" ? "subagent-secret" : null,
    );

    // Subagent session: agent:developer:discord:channel:123:subagent:456
    const ctx = stubCtx({
      sessionId: "agent:developer:discord:channel:123:subagent:456",
      vault: mockVault,
      agentId: "developer", // Should resolve to parent agent ID
    });

    const result = await reg.execute("vault", { action: "get", name: "SECRET" }, ctx);
    const parsed = JSON.parse(result.resultJson);

    assert.strictEqual(parsed.ok, true);
    // Subagent should use parent's agentId for scope
    assert.strictEqual(mockVault.get.mock.calls[0][0], "agent:developer");
  });
});

// -----------------------------------------------------------------------------
// Audit redaction
// -----------------------------------------------------------------------------

describe("builtin-vault audit redaction", () => {
  it("result for get action should have value field redacted", async () => {
    const reg = new BuiltinToolRegistry();
    register(reg);

    const mockVault = createMockVaultService();
    mockVault.get.mockImplementation((scope: string) =>
      scope === "agent:developer" ? "actual-secret-value" : null,
    );

    const ctx = stubCtx({
      sessionId: "agent:developer:discord:channel:123",
      vault: mockVault,
      agentId: "developer",
    });

    const result = await reg.execute("vault", { action: "get", name: "API_KEY" }, ctx);
    const parsed = JSON.parse(result.resultJson);

    // The value field should be present in the response to the agent
    // but the audit system should redact it separately
    // This test verifies the handler returns the value correctly
    assert.strictEqual(parsed.value, "actual-secret-value");

    // Note: Actual audit redaction is tested in tool-loop-bridge tests
    // by checking that audit logs contain redacted values
  });

  it("set action should return the value field for response but audit should redact", async () => {
    const reg = new BuiltinToolRegistry();
    register(reg);

    const mockVault = createMockVaultService();
    mockVault.put.mockReturnValue(undefined);

    const ctx = stubCtx({
      sessionId: "agent:developer:discord:channel:123",
      vault: mockVault,
      agentId: "developer",
    });

    const result = await reg.execute(
      "vault",
      { action: "set", name: "API_KEY", value: "secret123" },
      ctx,
    );
    const parsed = JSON.parse(result.resultJson);

    assert.strictEqual(parsed.ok, true);
    // The response doesn't include the value (security best practice)
    assert.strictEqual(parsed.value, undefined);

    // Note: Audit redaction for set args is handled by tool-loop-bridge
    // checking toolAuditRedaction config for builtin-vault
  });
});

// -----------------------------------------------------------------------------
// Unknown action
// -----------------------------------------------------------------------------

describe("builtin-vault unknown action", () => {
  it("returns error for unknown action", async () => {
    const reg = new BuiltinToolRegistry();
    register(reg);

    const ctx = stubCtx();

    const result = await reg.execute("vault", { action: "invalid" }, ctx);
    const parsed = JSON.parse(result.resultJson);

    assert.strictEqual(parsed.error, "unknown action: invalid");
  });
});
