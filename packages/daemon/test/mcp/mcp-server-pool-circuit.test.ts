/**
 * Connect retry + circuit breaker for the MCP pool:
 *  - per-server retry budget with backoff (controllable for tests)
 *  - breaker opens after the budget; failure state visible in statuses
 *  - one failing server never affects the others
 *  - without re-arm (automatic reconnect) an open circuit fails fast
 *  - an explicit reconnect re-arms and can succeed once the command works
 */
import assert from "node:assert";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, it } from "vitest";
import type { ShoggothMcpServerEntry } from "@shoggoth/shared";
import {
  connectShoggothMcpServers,
  isMcpServerCircuitOpen,
  resetMcpServerConnectCircuits,
} from "../../src/mcp/mcp-server-pool";

const mockServerPath = fileURLToPath(
  new URL("../../../mcp-integration/test/fixtures/mock-mcp-server.mjs", import.meta.url),
);

const MISSING = "/nonexistent/shoggoth-pool-does-not-exist";
const BAD_ID = "circuit-bad";
const GOOD_ID = "circuit-good";

const retry = { attempts: 3, baseDelayMs: 50 };
/** Total backoff slept across the budget: 50ms + 100ms. */
const RETRY_BUDGET_MS = retry.baseDelayMs * (2 ** (retry.attempts - 1) - 1);

function badEntry(): ShoggothMcpServerEntry {
  return { id: BAD_ID, transport: "stdio", command: MISSING };
}
function goodEntry(): ShoggothMcpServerEntry {
  return { id: GOOD_ID, transport: "stdio", command: process.execPath, args: [mockServerPath] };
}

describe("MCP pool connect retry + circuit breaker", () => {
  beforeEach(() => {
    resetMcpServerConnectCircuits();
  });

  it("spends the retry budget, opens the breaker, and leaves other servers unaffected", async () => {
    const started = Date.now();
    const { pool, statuses } = await connectShoggothMcpServers([badEntry(), goodEntry()], {
      connectRetry: retry,
    });
    const elapsed = Date.now() - started;
    try {
      const bad = statuses!.find((s) => s.id === BAD_ID)!;
      const good = statuses!.find((s) => s.id === GOOD_ID)!;

      assert.equal(bad.ok, false);
      assert.equal(bad.attempts, 3, "full retry budget consumed");
      assert.equal(bad.circuitOpen, true, "breaker open after budget exhausted");
      assert.match(bad.error ?? "", /spawn failed/);
      assert.ok(
        elapsed >= RETRY_BUDGET_MS - 60,
        `retries must back off between attempts (took ${elapsed}ms)`,
      );
      assert.ok(isMcpServerCircuitOpen(BAD_ID));

      assert.equal(good.ok, true, "other servers are unaffected by one failure");
      assert.equal(good.attempts, 1, "healthy server needed a single attempt");
      assert.equal(good.circuitOpen, undefined);
      assert.equal(pool.externalSources.length, 1, "healthy server joined the pool");
    } finally {
      await pool.close();
    }
  });

  it("fails fast without spawning when re-arm is withheld", async () => {
    await connectShoggothMcpServers([badEntry()], { connectRetry: retry }).then(
      (r) => r.pool.close(),
      () => {},
    );

    // All servers open → AggregateError, but only after a fail-fast (no sleeps).
    const started = Date.now();
    await assert.rejects(
      connectShoggothMcpServers([badEntry()], { rearmCircuits: false, connectRetry: retry }),
      /failed to connect/,
    );
    const elapsed = Date.now() - started;
    assert.ok(
      elapsed < RETRY_BUDGET_MS - 60,
      `open circuit must fail fast without the retry budget (took ${elapsed}ms)`,
    );

    // With a healthy server alongside, the status shape shows the skip.
    const { pool, statuses } = await connectShoggothMcpServers([badEntry(), goodEntry()], {
      rearmCircuits: false,
      connectRetry: retry,
    });
    try {
      const bad = statuses!.find((s) => s.id === BAD_ID)!;
      assert.equal(bad.ok, false);
      assert.equal(bad.attempts, 0, "open circuit consumes zero attempts");
      assert.equal(bad.circuitOpen, true);
      assert.equal(statuses!.find((s) => s.id === GOOD_ID)!.ok, true);
    } finally {
      await pool.close();
    }
  });

  it("re-arm path: same server id succeeds after the command is fixed", async () => {
    const first = await connectShoggothMcpServers([badEntry()], { connectRetry: retry }).then(
      (r) => r,
      () => undefined,
    );
    if (first) await first.pool.close();
    assert.ok(isMcpServerCircuitOpen(BAD_ID), "breaker must be open before re-arm");

    const { pool, statuses } = await connectShoggothMcpServers(
      [{ ...badEntry(), command: process.execPath, args: [mockServerPath] }],
      { connectRetry: retry },
    );
    try {
      const status = statuses!.find((s) => s.id === BAD_ID)!;
      assert.equal(status.ok, true, "explicit reconnect re-arms and can succeed");
      assert.equal(status.attempts, 1);
      assert.equal(status.circuitOpen, undefined);
      assert.equal(isMcpServerCircuitOpen(BAD_ID), false, "breaker closed after success");
      assert.equal(pool.externalSources.length, 1);
    } finally {
      await pool.close();
    }
  });
});
