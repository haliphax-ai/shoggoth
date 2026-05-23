/**
 * Tests: verify that McpStdioConnectOptions forwards uid/gid to spawn().
 *
 * These tests mock node:child_process so they don't conflict with the
 * integration tests in mcp-jsonrpc-transport.test.ts.
 */
import assert from "node:assert";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, it, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock child_process.spawn so we can inspect the options it receives.
// ---------------------------------------------------------------------------
const spawnMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => {
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
    // Immediately end stdout so the session doesn't hang
    setTimeout(() => stdout.end(), 5);
    return proc;
  },
}));

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
    } as McpStdioConnectOptions; // cast: uid/gid fields don't exist yet

    let session;
    try {
      session = await connectMcpStdioSession(opts);
    } catch {
      // spawn mock doesn't produce a real MCP server — that's fine
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
    };

    let session;
    try {
      session = await connectMcpStdioSession(opts);
    } catch {
      // spawn mock doesn't produce a real MCP server — that's fine
    }

    assert.ok(spawnMock.mock.calls.length > 0, "spawn should have been called");
    const spawnOpts = spawnMock.mock.calls[0]?.[2] as Record<string, unknown> | undefined;
    assert.ok(spawnOpts, "spawn should receive an options object");
    assert.equal(spawnOpts.uid, undefined, "spawn options should not include uid");
    assert.equal(spawnOpts.gid, undefined, "spawn options should not include gid");

    await session?.close().catch(() => {});
  });
});
