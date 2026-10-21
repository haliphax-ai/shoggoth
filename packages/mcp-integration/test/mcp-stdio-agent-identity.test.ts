/**
 * Tests: verify that McpStdioConnectOptions forwards uid/gid to spawn().
 *
 * DI: the spawn implementation is injected via `opts.spawnImpl` instead of
 * mocking `node:child_process` (import-order dependent under `--no-isolate`).
 */
import assert from "node:assert";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, it, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Fake spawn: records args and returns a minimal ChildProcess-like object.
// ---------------------------------------------------------------------------
const spawnMock = vi.fn();

function fakeSpawn(...args: unknown[]) {
  spawnMock(...args);
  // Return a minimal ChildProcess-like object with piped stdio
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const proc = Object.assign(new EventEmitter(), {
    stdout,
    stdin,
    stderr: null,
    pid: 99999,
    kill: vi.fn(),
  });
  // Real ChildProcess emits 'spawn' asynchronously after a successful start;
  // the connect handshake awaits it before returning the session. Zero-delay
  // setImmediate ticks keep both events on the loop, in order, with no
  // wall-clock wait.
  setImmediate(() => proc.emit("spawn"));
  // End stdout right after so the session doesn't hang.
  setImmediate(() => stdout.end());
  return proc;
}

import { connectMcpStdioSession, type McpStdioConnectOptions } from "../src/mcp-jsonrpc-transport";

describe("connectMcpStdioSession — uid/gid forwarding", () => {
  beforeEach(() => {
    spawnMock.mockClear();
  });

  it("passes uid and gid to spawn when provided", async () => {
    const opts = {
      command: "/usr/bin/echo",
      args: ["hello"],
      uid: 1001,
      gid: 1001,
      spawnImpl: fakeSpawn as typeof import("node:child_process").spawn,
    } as McpStdioConnectOptions;

    let session;
    try {
      session = await connectMcpStdioSession(opts);
    } catch {
      // spawn fake doesn't produce a real MCP server — that's fine
    }

    assert.ok(spawnMock.mock.calls.length > 0, "spawn should have been called");
    const spawnOpts = spawnMock.mock.calls[0]?.[2] as Record<string, unknown> | undefined;
    assert.ok(spawnOpts, "spawn should receive an options object");
    assert.equal(spawnOpts.uid, 1001, "spawn options should include uid");
    assert.equal(spawnOpts.gid, 1001, "spawn options should include gid");

    await session?.close().catch(() => {});
  });

  it("does not set uid/gid on spawn when not provided", async () => {
    const opts: McpStdioConnectOptions = {
      command: "/usr/bin/echo",
      args: ["hello"],
      spawnImpl: fakeSpawn as typeof import("node:child_process").spawn,
    };

    let session;
    try {
      session = await connectMcpStdioSession(opts);
    } catch {
      // spawn fake doesn't produce a real MCP server — that's fine
    }

    assert.ok(spawnMock.mock.calls.length > 0, "spawn should have been called");
    const spawnOpts = spawnMock.mock.calls[0]?.[2] as Record<string, unknown> | undefined;
    assert.ok(spawnOpts, "spawn should receive an options object");
    assert.equal(spawnOpts.uid, undefined, "spawn options should not include uid");
    assert.equal(spawnOpts.gid, undefined, "spawn options should not include gid");

    await session?.close().catch(() => {});
  });
});
