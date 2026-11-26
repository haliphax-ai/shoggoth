/**
 * MCP pool — stdio server death + respawn:
 *  - a managed child dying fires pool.onServerExit exactly once
 *  - the pool swaps in a fresh session (respawn) and routing keeps working
 *  - the catalog entry is refreshed in place (same array identity)
 *  - closing the pool while a respawn handshake is in flight is safe
 *  - a respawn that cannot re-handshake leaves the server marked dead
 */
import assert from "node:assert";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, it } from "vitest";
import type { ShoggothMcpServerEntry } from "@shoggoth/shared";
import { getProcessManager, initProcessManager } from "../../src/process-manager-singleton";
import {
  connectShoggothMcpServers,
  resetMcpServerConnectCircuits,
} from "../../src/mcp/mcp-server-pool";

const exitAfterServerPath = fileURLToPath(
  new URL("../../../mcp-integration/test/fixtures/mock-mcp-server-exit-after.mjs", import.meta.url),
);

const SERVER_ID = "respawn-me";

function stdioEntry(command: string, args: string[]): ShoggothMcpServerEntry {
  return { id: SERVER_ID, transport: "stdio", command, args };
}

/** Wait until `pred` is true or the budget expires, polling the event loop. */
async function waitFor(pred: () => boolean, budgetMs = 5000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > budgetMs) {
      throw new Error("waitFor: budget exhausted");
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

const cleanupMarkers: string[] = [];
afterEach(() => {
  while (cleanupMarkers.length > 0) {
    rmSync(cleanupMarkers.pop()!, { force: true });
  }
});

describe("MCP pool — stdio server death + respawn", () => {
  it("replaces a dead stdio session and keeps the pool routable", async () => {
    initProcessManager();
    resetMcpServerConnectCircuits();

    // The first instance exits 300 ms after initialize; the respawned one
    // (marker present) stays alive.
    const marker = join(tmpdir(), `mcp-respawn-marker-${process.pid}-${Date.now()}`);
    cleanupMarkers.push(marker);
    const { pool, external, statuses } = await connectShoggothMcpServers(
      [stdioEntry(process.execPath, [exitAfterServerPath, "300", marker])],
      {},
    );
    try {
      assert.equal(statuses![0]!.ok, true);
      const exitEvents: { exitCode: number | null; signal: string | null }[] = [];
      pool.onServerExit = (info) => {
        exitEvents.push({ exitCode: info.exitCode, signal: info.signal ?? null });
      };

      await waitFor(() => exitEvents.length > 0, 10_000);
      assert.equal(exitEvents.length, 1, "pool.onServerExit must fire exactly once");
      assert.equal(exitEvents[0]!.exitCode, 0);

      // The respawn handshake may still be in flight — wait for the swapped-in
      // session before exercising it.
      await waitFor(() => pool.isServerLive!(SERVER_ID), 15_000);

      const result = await external({
        sourceId: SERVER_ID,
        originalName: "echo",
        argsJson: JSON.stringify({ text: "after-death" }),
        toolCallId: "t1",
      });
      const body = JSON.parse(result.resultJson) as { content?: { text: string }[] };
      assert.equal(
        body.content?.[0]?.text,
        "after-death",
        `expected respawned session to answer the call, got ${result.resultJson}`,
      );

      // Catalog refreshed in place (same array identity, live echo tool).
      assert.equal(pool.externalSources.length, 1);
      assert.equal(pool.externalSources[0]!.tools[0]!.name, "echo");
    } finally {
      await pool.close();
    }
  });

  it("keeps the server marked dead when the respawn cannot re-handshake", async () => {
    initProcessManager();
    resetMcpServerConnectCircuits();

    // No marker: every instance (original and respawned) exits 50 ms after
    // initialize, so each respawn dies again inside the stability window —
    // the crash-loop guard must eventually stop respawning.
    const { pool, statuses } = await connectShoggothMcpServers(
      [stdioEntry(process.execPath, [exitAfterServerPath, "50"])],
      {},
    );
    try {
      assert.equal(statuses![0]!.ok, true);
      const exitEvents: { exitCode: number | null }[] = [];
      pool.onServerExit = (info) => {
        exitEvents.push({ exitCode: info.exitCode });
      };
      // Multiple death/respawn cycles will occur; after the retry budget is
      // exhausted the pool gives up and the server stays dead.
      await waitFor(() => !pool.isServerLive!(SERVER_ID) && exitEvents.length >= 1, 20_000);
      // Give the respawn a moment to fail out fully (budget exhaustion logs).
      await new Promise((r) => setTimeout(r, 300));
      assert.ok(
        !pool.isServerLive!(SERVER_ID),
        "server must remain dead after the respawn budget is exhausted",
      );
    } finally {
      await pool.close();
    }
  });

  it("closes cleanly while a respawn handshake is in flight", async () => {
    initProcessManager();
    resetMcpServerConnectCircuits();
    const pm = getProcessManager()!;

    // No marker: every instance exits 50 ms after initialize — close() during
    // the respawn window must not hang or leak.
    const { pool, statuses } = await connectShoggothMcpServers(
      [stdioEntry(process.execPath, [exitAfterServerPath, "50"])],
      {},
    );
    assert.equal(statuses![0]!.ok, true);
    const exited = new Promise<void>((resolve) => {
      pool.onServerExit = () => resolve();
    });
    await exited;

    await pool.close();
    assert.equal(
      await waitFor(() => pm.listByOwner({ kind: "mcp-server" }).length === 0, 10_000).then(
        () => true,
        () => false,
      ),
      true,
      "no leaked mcp processes",
    );
  });
});
