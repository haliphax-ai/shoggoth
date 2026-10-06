/**
 * Catalog refresh visibility through resolveContext (the acceptance criterion
 * for tools/list_changed handling): after a pool replaces a source's catalog
 * entry in place and notifies the runtime, the NEXT resolveContext serves the
 * refreshed tool list without reconnecting — for every context shape:
 *
 * 1. global-only fast path (cached `globalOnlyMcpCtx` snapshot),
 * 2. per-session cached context (two/three-tier shapes),
 * 3. per-agent merged context (built fresh from live arrays),
 * 4. denied-then-re-enabled server (pool refresh is rules-agnostic).
 *
 * The fake connect reproduces exactly what the real pool does on
 * notifications/tools/list_changed: swap the entry in `externalSources` at the
 * same index (array identity preserved), then call `onToolCatalogChange`.
 */
import type { McpSourceCatalog } from "@shoggoth/mcp-integration";
import type { ShoggothConfig, ShoggothMcpServerEntry } from "@shoggoth/shared";
import { defaultConfig, formatAgentSessionUrn } from "@shoggoth/shared";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultMigrationsDir, migrate } from "../../src/db/migrate";
import type { ConnectShoggothMcpPoolOptions, McpServerPool } from "../../src/mcp/mcp-server-pool";
import { createSessionMcpRuntime } from "../../src/sessions/session-mcp-runtime";
import type { SessionMcpToolContext } from "../../src/sessions/session-mcp-tool-context";
import { closeTestDb } from "../helpers/close-test-db";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function serverEntry(
  id: string,
  poolScope: "global" | "per_agent" | "per_session",
): ShoggothMcpServerEntry {
  return { id, transport: "stdio" as const, command: "echo", poolScope } as ShoggothMcpServerEntry;
}

function configWithServers(
  workspacePath: string,
  servers: ShoggothMcpServerEntry[],
): ShoggothConfig {
  const cfg = defaultConfig(workspacePath);
  cfg.mcp = { ...cfg.mcp, servers, poolScope: "global" };
  return cfg;
}

function catalogFor(sourceId: string, toolName: string): McpSourceCatalog {
  return {
    sourceId,
    tools: [
      {
        name: toolName,
        description: toolName,
        inputSchema: { type: "object", properties: {} },
      },
    ],
  };
}

type FakePool = {
  readonly sources: McpSourceCatalog[];
  readonly options: ConnectShoggothMcpPoolOptions | undefined;
};

/**
 * Fake `connectShoggothMcpServers` that records each pool's live
 * `externalSources` array and the options it was called with, plus a
 * `simulateRefresh` that performs the pool's in-place replace + notification.
 */
function createFakePoolConnect() {
  const pools: FakePool[] = [];
  const connectShoggothMcpServers = vi.fn(
    async (servers: readonly ShoggothMcpServerEntry[], options?: ConnectShoggothMcpPoolOptions) => {
      const sources: McpSourceCatalog[] = servers.map((s) => catalogFor(s.id, "old"));
      pools.push({ sources, options });
      const pool: McpServerPool = { externalSources: sources, close: vi.fn(async () => {}) };
      return { pool, external: vi.fn(async () => ({ resultJson: "{}" })) };
    },
  );

  /** Reproduce the pool's tools/list_changed reaction: replace in place, then notify. */
  function simulateRefresh(poolIndex: number, sourceId: string, toolName: string): void {
    const record = pools[poolIndex];
    if (!record) throw new Error(`no fake pool at index ${poolIndex}`);
    const idx = record.sources.findIndex((c) => c.sourceId === sourceId);
    if (idx === -1) throw new Error(`source ${sourceId} not in pool ${poolIndex}`);
    record.sources[idx] = catalogFor(sourceId, toolName);
    record.options?.onToolCatalogChange?.({ sourceId });
  }

  return { connectShoggothMcpServers, pools, simulateRefresh };
}

function namespacedNames(ctx: SessionMcpToolContext): string[] {
  return ctx.aggregated.tools.map((t) => t.namespacedName);
}

const SESSION = formatAgentSessionUrn(
  "myagent",
  "discord",
  "channel",
  "aaaaaaaa-0000-4000-8000-000000000001",
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveContext serves refreshed MCP catalogs without reconnecting", () => {
  let tmp: string;
  let db: Database.Database;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "shoggoth-mcp-catalog-refresh-"));
    db = new Database(join(tmp, "s.db"));
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());
  });

  afterEach(async () => {
    await closeTestDb(db, tmp);
  });

  // 1. THE acceptance test: global-only fast path (cached globalOnlyMcpCtx).
  it("rebuilds the cached global-only context on the next resolveContext", async () => {
    const fake = createFakePoolConnect();
    const config = configWithServers(tmp, [serverEntry("srv", "global")]);
    const runtime = await createSessionMcpRuntime({
      config,
      env: process.env,
      db,
      deps: { connectShoggothMcpServers: fake.connectShoggothMcpServers },
    });
    try {
      const ctx1 = await runtime.resolveContext(SESSION);
      expect(namespacedNames(ctx1)).toContain("srv-old");

      fake.simulateRefresh(0, "srv", "new");

      const ctx2 = await runtime.resolveContext(SESSION);
      expect(namespacedNames(ctx2)).toContain("srv-new");
      expect(namespacedNames(ctx2)).not.toContain("srv-old");
      // No reconnect: the pool was connected exactly once.
      expect(fake.connectShoggothMcpServers).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.shutdown();
    }
  });

  // 2. Per-session cached context (two-tier: global + per-session).
  it("rebuilds the cached per-session context after either tier refreshes", async () => {
    const fake = createFakePoolConnect();
    const config = configWithServers(tmp, [
      serverEntry("gsrv", "global"),
      serverEntry("ssrv", "per_session"),
    ]);
    const runtime = await createSessionMcpRuntime({
      config,
      env: process.env,
      db,
      deps: { connectShoggothMcpServers: fake.connectShoggothMcpServers },
    });
    try {
      const ctx1 = await runtime.resolveContext(SESSION);
      expect(namespacedNames(ctx1)).toEqual(expect.arrayContaining(["gsrv-old", "ssrv-old"]));

      // Global tier refresh → next resolveContext sees it (cached entry rebuilt).
      fake.simulateRefresh(0, "gsrv", "new");
      const ctx2 = await runtime.resolveContext(SESSION);
      expect(namespacedNames(ctx2)).toEqual(expect.arrayContaining(["gsrv-new", "ssrv-old"]));

      // Per-session tier refresh → same cached entry rebuilt again.
      fake.simulateRefresh(1, "ssrv", "new");
      const ctx3 = await runtime.resolveContext(SESSION);
      expect(namespacedNames(ctx3)).toEqual(expect.arrayContaining(["gsrv-new", "ssrv-new"]));
      expect(namespacedNames(ctx3)).not.toContain("ssrv-old");
      expect(fake.connectShoggothMcpServers).toHaveBeenCalledTimes(2);
    } finally {
      await runtime.shutdown();
    }
  });

  // 3. Per-agent merged context (built fresh from live arrays each resolve).
  it("serves a refreshed per-agent catalog on the next resolveContext", async () => {
    const fake = createFakePoolConnect();
    const config = configWithServers(tmp, [
      serverEntry("gsrv", "global"),
      serverEntry("asrv", "per_agent"),
    ]);
    const runtime = await createSessionMcpRuntime({
      config,
      env: process.env,
      db,
      deps: { connectShoggothMcpServers: fake.connectShoggothMcpServers },
    });
    try {
      const ctx1 = await runtime.resolveContext(SESSION);
      expect(namespacedNames(ctx1)).toEqual(expect.arrayContaining(["gsrv-old", "asrv-old"]));

      fake.simulateRefresh(1, "asrv", "new");
      const ctx2 = await runtime.resolveContext(SESSION);
      expect(namespacedNames(ctx2)).toContain("asrv-new");
      expect(namespacedNames(ctx2)).not.toContain("asrv-old");
      expect(fake.connectShoggothMcpServers).toHaveBeenCalledTimes(2);
    } finally {
      await runtime.shutdown();
    }
  });

  // 4. Denied-server scenario: the pool refresh is rules-agnostic, so a catalog
  // changed while the server was denied is already fresh when rules re-allow it.
  it("shows a fresh catalog when a denied server is re-enabled", async () => {
    const fake = createFakePoolConnect();
    const config = configWithServers(tmp, [serverEntry("srv", "global")]);
    config.mcp!.serverRules = { allow: ["*"], deny: ["srv"] };
    const runtime = await createSessionMcpRuntime({
      config,
      env: process.env,
      db,
      deps: { connectShoggothMcpServers: fake.connectShoggothMcpServers },
    });
    try {
      const ctx1 = await runtime.resolveContext(SESSION);
      expect(namespacedNames(ctx1)).not.toContain("srv-old");

      // The server stays connected while denied (pool warmth) and keeps
      // notifying: the catalog refresh happens regardless of rules.
      fake.simulateRefresh(0, "srv", "fresh");
      const stillDenied = await runtime.resolveContext(SESSION);
      expect(namespacedNames(stillDenied)).not.toContain("srv-fresh");

      // Rules resolve per call — re-enabling needs no reconnect.
      config.mcp!.serverRules = { allow: ["*"], deny: [] };
      const reEnabled = await runtime.resolveContext(SESSION);
      expect(namespacedNames(reEnabled)).toContain("srv-fresh");
      expect(namespacedNames(reEnabled)).not.toContain("srv-old");
      expect(fake.connectShoggothMcpServers).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.shutdown();
    }
  });
});
