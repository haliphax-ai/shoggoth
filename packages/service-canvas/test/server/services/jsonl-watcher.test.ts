/**
 * Tests for the JSONL watcher's file processing behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JSONLWatcher } from "../../../src/server/services/jsonl-watcher";
import type { Gateway } from "../../../src/server/services/gateway";
import type { A2UIManager } from "../../../src/server/services/a2ui-manager";

describe("JSONLWatcher.processFile", () => {
  let tmpDir: string;
  let broadcastOrder: Array<{ session: string; type: string }>;
  let gateway: Gateway;
  let a2uiManager: A2UIManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jsonl-watcher-test-"));
    broadcastOrder = [];
    gateway = {
      broadcastSpaSession: (session: string, msg: Record<string, unknown>) => {
        broadcastOrder.push({ session, type: String(msg.type) });
      },
    } as unknown as Gateway;
    a2uiManager = {
      upsertSurface: vi.fn(),
      setRoot: vi.fn(),
      updateDataModel: vi.fn(),
      deleteSurface: vi.fn(),
    } as unknown as A2UIManager;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function makeWatcher(): JSONLWatcher {
    return new JSONLWatcher(new Map([["s1", tmpDir]]), gateway, a2uiManager, {
      watch: false,
    });
  }

  it("applies commands from a file in order", async () => {
    const watcher = makeWatcher();
    try {
      const file = path.join(tmpDir, "canvas.jsonl");
      fs.writeFileSync(
        file,
        [
          JSON.stringify({ createSurface: { surfaceId: "surf" } }),
          JSON.stringify({
            updateComponents: { surfaceId: "surf", components: [{ id: "a", component: "text" }] },
          }),
          JSON.stringify({ updateDataModel: { surfaceId: "surf", data: { n: 1 } } }),
          JSON.stringify({
            updateComponents: { surfaceId: "surf", components: [{ id: "b", component: "text" }] },
          }),
        ].join("\n") + "\n",
      );

      await watcher.processFile("s1", file);

      expect(broadcastOrder.map((b) => b.type)).toEqual([
        "a2ui.createSurface",
        "a2ui.updateComponents",
        "a2ui.updateDataModel",
        "a2ui.updateComponents",
      ]);
    } finally {
      watcher.close();
    }
  });

  it("serializes concurrent processing of the same file", async () => {
    const watcher = makeWatcher();
    try {
      const file = path.join(tmpDir, "canvas.jsonl");
      fs.writeFileSync(
        file,
        [
          JSON.stringify({ createSurface: { surfaceId: "surf" } }),
          JSON.stringify({ updateDataModel: { surfaceId: "surf", data: { n: 1 } } }),
        ].join("\n") + "\n",
      );

      await Promise.all([watcher.processFile("s1", file), watcher.processFile("s1", file)]);

      // Each run applies its lines in order; runs never interleave.
      expect(broadcastOrder.map((b) => b.type)).toEqual([
        "a2ui.createSurface",
        "a2ui.updateDataModel",
        "a2ui.createSurface",
        "a2ui.updateDataModel",
      ]);
    } finally {
      watcher.close();
    }
  });

  it("does not let a malformed line break the remaining lines", async () => {
    const watcher = makeWatcher();
    try {
      const file = path.join(tmpDir, "canvas.jsonl");
      fs.writeFileSync(
        file,
        [
          "{not json",
          JSON.stringify({ createSurface: { surfaceId: "surf" } }),
          JSON.stringify({
            updateComponents: { surfaceId: "surf", components: [{ id: "a", component: "text" }] },
          }),
        ].join("\n") + "\n",
      );

      await watcher.processFile("s1", file);

      expect(broadcastOrder.map((b) => b.type)).toEqual([
        "a2ui.createSurface",
        "a2ui.updateComponents",
      ]);
    } finally {
      watcher.close();
    }
  });

  it("does not let a thrown command error break the remaining lines", async () => {
    // Make the pipeline throw while handling the first line (via the manager
    // mock); the watcher must catch it and keep processing the rest.
    const upsertCalls: string[][] = [];
    (a2uiManager.upsertSurface as ReturnType<typeof vi.fn>).mockImplementation(() => {
      upsertCalls.push([]);
      throw new Error("boom");
    });

    const watcher = makeWatcher();
    try {
      const file = path.join(tmpDir, "canvas.jsonl");
      fs.writeFileSync(
        file,
        [
          JSON.stringify({
            updateComponents: { surfaceId: "surf", components: [{ id: "a", component: "text" }] },
          }),
          JSON.stringify({ updateDataModel: { surfaceId: "surf", data: { n: 1 } } }),
        ].join("\n") + "\n",
      );

      await watcher.processFile("s1", file);

      expect(upsertCalls).toHaveLength(1);
      expect(broadcastOrder.map((b) => b.type)).toEqual(["a2ui.updateDataModel"]);
    } finally {
      watcher.close();
    }
  });

  it("resolves processing started before close() without applying commands afterwards", async () => {
    const watcher = makeWatcher();
    const file = path.join(tmpDir, "canvas.jsonl");
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ createSurface: { surfaceId: "surf" } }),
        JSON.stringify({ updateDataModel: { surfaceId: "surf", data: { n: 1 } } }),
      ].join("\n") + "\n",
    );

    const processing = watcher.processFile("s1", file);
    watcher.close();
    await processing;

    // The read completed after close, so nothing is applied — but the call
    // must resolve (no hang) and must not reject.
    expect(broadcastOrder).toEqual([]);
  });

  it("closeAndWait waits for queued processing to finish", async () => {
    const watcher = makeWatcher();
    try {
      const file = path.join(tmpDir, "canvas.jsonl");
      fs.writeFileSync(
        file,
        [
          JSON.stringify({ createSurface: { surfaceId: "surf" } }),
          JSON.stringify({ updateDataModel: { surfaceId: "surf", data: { n: 1 } } }),
        ].join("\n") + "\n",
      );

      const first = watcher.processFile("s1", file);
      const second = watcher.processFile("s1", file);
      await watcher.closeAndWait();
      await Promise.all([first, second]);

      expect(broadcastOrder.map((b) => b.type)).toEqual([
        "a2ui.createSurface",
        "a2ui.updateDataModel",
        "a2ui.createSurface",
        "a2ui.updateDataModel",
      ]);
    } finally {
      watcher.close();
    }
  });

  it("processFile on a missing file resolves without error", async () => {
    const watcher = makeWatcher();
    try {
      await expect(
        watcher.processFile("s1", path.join(tmpDir, "missing.jsonl")),
      ).resolves.toBeUndefined();
      expect(broadcastOrder).toEqual([]);
    } finally {
      watcher.close();
    }
  });

  it("can be constructed with watchers disabled and closed safely", () => {
    const watcher = new JSONLWatcher(new Map([["s1", tmpDir]]), gateway, a2uiManager, {
      watch: false,
    });
    expect(() => watcher.close()).not.toThrow();
  });

  it("emits and processes appends through chokidar watchers when enabled", async () => {
    const watcher = new JSONLWatcher(new Map([["s1", tmpDir]]), gateway, a2uiManager, {
      watch: true,
      debounceMs: 30,
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const jsonlDir = path.join(tmpDir, "jsonl");
      fs.mkdirSync(jsonlDir, { recursive: true });

      // Create + append a command line; chokidar (add/change) triggers debounce
      // then a full-file process that applies the buffered line.
      fs.writeFileSync(
        path.join(jsonlDir, "canvas.jsonl"),
        JSON.stringify({
          createSurface: { surfaceId: "surf" },
        }) + "\n",
      );
      fs.appendFileSync(
        path.join(jsonlDir, "canvas.jsonl"),
        JSON.stringify({ updateDataModel: { surfaceId: "surf", data: { n: 1 } } }) + "\n",
      );

      const deadline = Date.now() + 2000;
      while (broadcastOrder.length < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      expect(broadcastOrder.map((b) => b.type)).toEqual([
        "a2ui.createSurface",
        "a2ui.updateDataModel",
      ]);
    } finally {
      await watcher.closeAndWait();
    }
  });
});
