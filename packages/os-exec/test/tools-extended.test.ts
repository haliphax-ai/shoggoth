import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { toolReadExtended } from "../src/tools";
import type {
  ReadSingleResult,
  ReadMultiResult,
  StatSingleResult,
  StatMultiResult,
} from "../src/tools";

describe("toolReadExtended", () => {
  let ws: string;
  const creds = { uid: process.getuid!(), gid: process.getgid!() };

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "shoggoth-read-ext-"));
    // Create a small file tree for testing
    mkdirSync(join(ws, "src"), { recursive: true });
    mkdirSync(join(ws, "data"), { recursive: true });
    writeFileSync(join(ws, "hello.txt"), "line1\nline2\nline3\nline4\nline5\n");
    writeFileSync(join(ws, "src/a.ts"), "const a = 1;\n");
    writeFileSync(join(ws, "src/b.ts"), "const b = 2;\n");
    writeFileSync(join(ws, "src/c.js"), "const c = 3;\n");
    writeFileSync(join(ws, "data/info.json"), '{"key":"value"}\n');
  });

  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // Backward compatibility — single path, no new params
  // -----------------------------------------------------------------------

  describe("single-path (backward compat)", () => {
    it("reads a file and returns kind=single", async () => {
      const r = await toolReadExtended(ws, { path: "hello.txt" }, creds);
      assert.equal(r.kind, "single");
      assert.equal((r as ReadSingleResult).content, "line1\nline2\nline3\nline4\nline5\n");
    });
  });

  // -----------------------------------------------------------------------
  // fromLine / toLine
  // -----------------------------------------------------------------------

  describe("fromLine / toLine", () => {
    it("slices lines inclusively (1-indexed)", async () => {
      const r = await toolReadExtended(ws, { path: "hello.txt", fromLine: 2, toLine: 4 }, creds);
      assert.equal(r.kind, "single");
      assert.equal((r as ReadSingleResult).content, "line2\nline3\nline4");
    });

    it("fromLine only — reads from that line to EOF", async () => {
      const r = await toolReadExtended(ws, { path: "hello.txt", fromLine: 4 }, creds);
      assert.equal(r.kind, "single");
      assert.equal((r as ReadSingleResult).content, "line4\nline5\n");
    });

    it("toLine only — reads from start to that line", async () => {
      const r = await toolReadExtended(ws, { path: "hello.txt", toLine: 2 }, creds);
      assert.equal(r.kind, "single");
      assert.equal((r as ReadSingleResult).content, "line1\nline2");
    });

    it("toLine beyond EOF returns up to EOF without error", async () => {
      const r = await toolReadExtended(ws, { path: "hello.txt", fromLine: 4, toLine: 999 }, creds);
      assert.equal(r.kind, "single");
      assert.equal((r as ReadSingleResult).content, "line4\nline5\n");
    });

    it("fromLine beyond EOF returns empty content", async () => {
      const r = await toolReadExtended(ws, { path: "hello.txt", fromLine: 999 }, creds);
      assert.equal(r.kind, "single");
      assert.equal((r as ReadSingleResult).content, "");
    });

    it("fromLine > toLine throws an error", async () => {
      await assert.rejects(
        () => toolReadExtended(ws, { path: "hello.txt", fromLine: 5, toLine: 2 }, creds),
        /fromLine.*must be.*toLine/,
      );
    });

    it("negative fromLine throws an error", async () => {
      await assert.rejects(
        () => toolReadExtended(ws, { path: "hello.txt", fromLine: -1 }, creds),
        /fromLine.*must be >= 1/,
      );
    });
  });

  // -----------------------------------------------------------------------
  // offset / limit (existing params, still work)
  // -----------------------------------------------------------------------

  describe("offset / limit (existing)", () => {
    it("offset + limit slices correctly", async () => {
      const r = await toolReadExtended(ws, { path: "hello.txt", offset: 2, limit: 2 }, creds);
      assert.equal(r.kind, "single");
      assert.equal((r as ReadSingleResult).content, "line2\nline3");
    });
  });

  // -----------------------------------------------------------------------
  // Mutual exclusivity
  // -----------------------------------------------------------------------

  describe("mutual exclusivity", () => {
    it("rejects path + paths together", async () => {
      await assert.rejects(
        () => toolReadExtended(ws, { path: "hello.txt", paths: ["src/*.ts"] }, creds),
        /Cannot specify both/,
      );
    });

    it("rejects fromLine + offset together", async () => {
      await assert.rejects(
        () => toolReadExtended(ws, { path: "hello.txt", fromLine: 1, offset: 1 }, creds),
        /Cannot combine/,
      );
    });

    it("rejects toLine + limit together", async () => {
      await assert.rejects(
        () => toolReadExtended(ws, { path: "hello.txt", toLine: 5, limit: 5 }, creds),
        /Cannot combine/,
      );
    });

    it("rejects when neither path nor paths is provided", async () => {
      await assert.rejects(
        () => toolReadExtended(ws, {}, creds),
        /Either.*path.*or.*paths.*must be provided/,
      );
    });
  });

  // -----------------------------------------------------------------------
  // Glob / multi-path
  // -----------------------------------------------------------------------

  describe("paths (glob / multi-path)", () => {
    it("reads multiple explicit files", async () => {
      const r = await toolReadExtended(ws, { paths: ["src/a.ts", "src/b.ts"] }, creds);
      assert.equal(r.kind, "multi");
      const multi = r as ReadMultiResult;
      assert.equal(multi.files["src/a.ts"], "const a = 1;\n");
      assert.equal(multi.files["src/b.ts"], "const b = 2;\n");
    });

    it("expands glob patterns", async () => {
      const r = await toolReadExtended(ws, { paths: ["src/*.ts"] }, creds);
      assert.equal(r.kind, "multi");
      const multi = r as ReadMultiResult;
      // Should match a.ts and b.ts but not c.js
      assert.ok("src/a.ts" in multi.files);
      assert.ok("src/b.ts" in multi.files);
      assert.ok(!("src/c.js" in multi.files));
    });

    it("mixes explicit paths and globs", async () => {
      const r = await toolReadExtended(ws, { paths: ["hello.txt", "src/*.ts"] }, creds);
      assert.equal(r.kind, "multi");
      const multi = r as ReadMultiResult;
      assert.ok("hello.txt" in multi.files);
      assert.ok("src/a.ts" in multi.files);
      assert.ok("src/b.ts" in multi.files);
    });

    it("applies line range to all matched files", async () => {
      const r = await toolReadExtended(ws, { paths: ["src/a.ts", "src/b.ts"], toLine: 1 }, creds);
      assert.equal(r.kind, "multi");
      const multi = r as ReadMultiResult;
      assert.equal(multi.files["src/a.ts"], "const a = 1;");
      assert.equal(multi.files["src/b.ts"], "const b = 2;");
    });

    it("respects maxFiles cap", async () => {
      const r = await toolReadExtended(ws, { paths: ["src/*"], maxFiles: 1 }, creds);
      assert.equal(r.kind, "multi");
      const multi = r as ReadMultiResult;
      assert.equal(Object.keys(multi.files).length, 1);
      assert.ok(multi.notices?.some((n) => n.includes("capped")));
    });

    it("returns empty files with notice when glob matches nothing", async () => {
      const r = await toolReadExtended(ws, { paths: ["nonexistent/*.xyz"] }, creds);
      assert.equal(r.kind, "multi");
      const multi = r as ReadMultiResult;
      assert.equal(Object.keys(multi.files).length, 0);
      assert.ok(multi.notices?.some((n) => n.includes("No files matched")));
    });

    it("skips binary files with a notice", async () => {
      // Write a file with NUL bytes to simulate binary
      writeFileSync(join(ws, "data/bin.dat"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]));
      const r = await toolReadExtended(ws, { paths: ["data/bin.dat"] }, creds);
      assert.equal(r.kind, "multi");
      const multi = r as ReadMultiResult;
      assert.equal(multi.files["data/bin.dat"], "[binary file, skipped]");
      assert.ok(multi.notices?.some((n) => n.includes("binary")));
    });
  });

  // -----------------------------------------------------------------------
  // Stat mode
  // -----------------------------------------------------------------------

  describe("stat mode", () => {
    it("returns stat for a single file", async () => {
      const r = await toolReadExtended(ws, { path: "hello.txt", stat: true }, creds);
      assert.equal(r.kind, "stat-single");
      const st = (r as StatSingleResult).stat;
      assert.equal(st.type, "file");
      assert.ok(st.size > 0);
      assert.ok(st.sizeHuman.length > 0);
      assert.ok(st.mtime.length > 0);
      assert.ok(st.permissions.length === 9);
      assert.equal(typeof st.lines, "number");
    });

    it("returns stat for a directory", async () => {
      const r = await toolReadExtended(ws, { path: "src", stat: true }, creds);
      assert.equal(r.kind, "stat-single");
      const st = (r as StatSingleResult).stat;
      assert.equal(st.type, "directory");
    });

    it("returns stat for a symlink with target info", async () => {
      symlinkSync(join(ws, "hello.txt"), join(ws, "link.txt"));
      const r = await toolReadExtended(ws, { path: "link.txt", stat: true }, creds);
      assert.equal(r.kind, "stat-single");
      const st = (r as StatSingleResult).stat;
      assert.equal(st.type, "file"); // target type
      assert.equal(st.symlink, true);
      assert.ok(st.target?.includes("hello.txt"));
    });

    it("returns stat-multi for glob patterns", async () => {
      const r = await toolReadExtended(ws, { paths: ["src/*.ts"], stat: true }, creds);
      assert.equal(r.kind, "stat-multi");
      const stats = (r as StatMultiResult).stats;
      assert.equal(stats.length, 2);
      assert.ok(stats.every((s) => s.type === "file"));
      assert.ok(stats.every((s) => s.size > 0));
    });

    it("stat ignores line-range params without error", async () => {
      // Per proposal: stat with fromLine/toLine should just ignore them
      const r = await toolReadExtended(ws, { path: "hello.txt", stat: true, fromLine: 2, toLine: 4 }, creds);
      assert.equal(r.kind, "stat-single");
      const st = (r as StatSingleResult).stat;
      assert.equal(st.type, "file");
    });

    it("handles non-existent path in multi-stat gracefully", async () => {
      const r = await toolReadExtended(ws, { paths: ["src/a.ts", "nope.txt"], stat: true }, creds);
      assert.equal(r.kind, "stat-multi");
      const stats = (r as StatMultiResult).stats;
      assert.equal(stats.length, 2);
      // One should succeed, one should have an error
      const errStat = stats.find((s) => s.error);
      assert.ok(errStat, "expected an error entry for non-existent file");
    });
  });
});
