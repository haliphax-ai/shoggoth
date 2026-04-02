import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { toolWrite } from "../src/tools";
import type { WriteResult } from "../src/tools";

describe("toolWrite", () => {
  let ws: string;
  const creds = { uid: process.getuid!(), gid: process.getgid!() };

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "shoggoth-write-ext-"));
  });

  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // Backward compatibility — plain overwrite
  // -----------------------------------------------------------------------

  describe("overwrite (backward compat)", () => {
    it("writes a new file", async () => {
      const r = await toolWrite(ws, { path: "out.txt", content: "hello\n" }, creds);
      assert.equal(readFileSync(join(ws, "out.txt"), "utf8"), "hello\n");
      assert.equal(r.bytesWritten, Buffer.byteLength("hello\n", "utf8"));
    });

    it("overwrites an existing file", async () => {
      writeFileSync(join(ws, "out.txt"), "old content\n");
      await toolWrite(ws, { path: "out.txt", content: "new content\n" }, creds);
      assert.equal(readFileSync(join(ws, "out.txt"), "utf8"), "new content\n");
    });

    it("writes empty content", async () => {
      await toolWrite(ws, { path: "empty.txt", content: "" }, creds);
      assert.equal(readFileSync(join(ws, "empty.txt"), "utf8"), "");
    });
  });

  // -----------------------------------------------------------------------
  // Append mode
  // -----------------------------------------------------------------------

  describe("append mode", () => {
    it("appends to an existing file", async () => {
      writeFileSync(join(ws, "log.txt"), "line1\n");
      await toolWrite(ws, { path: "log.txt", content: "line2\n", append: true }, creds);
      assert.equal(readFileSync(join(ws, "log.txt"), "utf8"), "line1\nline2\n");
    });

    it("creates the file if it doesn't exist", async () => {
      await toolWrite(ws, { path: "new.log", content: "first\n", append: true }, creds);
      assert.equal(readFileSync(join(ws, "new.log"), "utf8"), "first\n");
    });

    it("appends multiple times", async () => {
      await toolWrite(ws, { path: "multi.log", content: "a\n", append: true }, creds);
      await toolWrite(ws, { path: "multi.log", content: "b\n", append: true }, creds);
      await toolWrite(ws, { path: "multi.log", content: "c\n", append: true }, creds);
      assert.equal(readFileSync(join(ws, "multi.log"), "utf8"), "a\nb\nc\n");
    });

    it("does not add implicit newlines", async () => {
      writeFileSync(join(ws, "no-nl.txt"), "existing");
      await toolWrite(ws, { path: "no-nl.txt", content: "-appended", append: true }, creds);
      assert.equal(readFileSync(join(ws, "no-nl.txt"), "utf8"), "existing-appended");
    });

    it("returns correct bytesWritten for append", async () => {
      writeFileSync(join(ws, "log.txt"), "existing\n");
      const r = await toolWrite(ws, { path: "log.txt", content: "new\n", append: true }, creds);
      assert.equal(r.bytesWritten, Buffer.byteLength("new\n", "utf8"));
    });
  });

  // -----------------------------------------------------------------------
  // Line-range replace (startLine / endLine)
  // -----------------------------------------------------------------------

  describe("line-range replace", () => {
    it("replaces a single line", async () => {
      writeFileSync(join(ws, "f.txt"), "aaa\nbbb\nccc\nddd\n");
      await toolWrite(ws, {
        path: "f.txt", content: "BBB", startLine: 2,
      }, creds);
      assert.equal(readFileSync(join(ws, "f.txt"), "utf8"), "aaa\nBBB\nccc\nddd\n");
    });

    it("replaces a range of lines", async () => {
      writeFileSync(join(ws, "f.txt"), "aaa\nbbb\nccc\nddd\neee\n");
      await toolWrite(ws, {
        path: "f.txt", content: "XXX\nYYY", startLine: 2, endLine: 4,
      }, creds);
      assert.equal(readFileSync(join(ws, "f.txt"), "utf8"), "aaa\nXXX\nYYY\neee\n");
    });

    it("deletes lines when content is empty", async () => {
      writeFileSync(join(ws, "f.txt"), "aaa\nbbb\nccc\nddd\n");
      await toolWrite(ws, {
        path: "f.txt", content: "", startLine: 2, endLine: 3,
      }, creds);
      assert.equal(readFileSync(join(ws, "f.txt"), "utf8"), "aaa\nddd\n");
    });

    it("replaces the first line", async () => {
      writeFileSync(join(ws, "f.txt"), "aaa\nbbb\nccc\n");
      await toolWrite(ws, {
        path: "f.txt", content: "AAA", startLine: 1, endLine: 1,
      }, creds);
      assert.equal(readFileSync(join(ws, "f.txt"), "utf8"), "AAA\nbbb\nccc\n");
    });

    it("errors when file does not exist", async () => {
      await assert.rejects(
        () => toolWrite(ws, { path: "nope.txt", content: "x", startLine: 1 }, creds),
        /ENOENT|does not exist|no such file/i,
      );
    });

    it("errors when startLine is out of range", async () => {
      writeFileSync(join(ws, "f.txt"), "aaa\nbbb\n");
      await assert.rejects(
        () => toolWrite(ws, { path: "f.txt", content: "x", startLine: 999 }, creds),
        /out of range/,
      );
    });

    it("errors when endLine is out of range", async () => {
      writeFileSync(join(ws, "f.txt"), "aaa\nbbb\n");
      await assert.rejects(
        () => toolWrite(ws, { path: "f.txt", content: "x", startLine: 1, endLine: 999 }, creds),
        /out of range/,
      );
    });
  });

  // -----------------------------------------------------------------------
  // Insert after (insertAfter)
  // -----------------------------------------------------------------------

  describe("insertAfter", () => {
    it("inserts after a specific line", async () => {
      writeFileSync(join(ws, "f.txt"), "aaa\nbbb\nccc\n");
      await toolWrite(ws, {
        path: "f.txt", content: "NEW", insertAfter: 2,
      }, creds);
      assert.equal(readFileSync(join(ws, "f.txt"), "utf8"), "aaa\nbbb\nNEW\nccc\n");
    });

    it("inserts before the first line with insertAfter=0", async () => {
      writeFileSync(join(ws, "f.txt"), "aaa\nbbb\n");
      await toolWrite(ws, {
        path: "f.txt", content: "FIRST", insertAfter: 0,
      }, creds);
      assert.equal(readFileSync(join(ws, "f.txt"), "utf8"), "FIRST\naaa\nbbb\n");
    });

    it("inserts multiple lines", async () => {
      writeFileSync(join(ws, "f.txt"), "aaa\nbbb\n");
      await toolWrite(ws, {
        path: "f.txt", content: "X\nY\nZ", insertAfter: 1,
      }, creds);
      assert.equal(readFileSync(join(ws, "f.txt"), "utf8"), "aaa\nX\nY\nZ\nbbb\n");
    });

    it("errors when file does not exist", async () => {
      await assert.rejects(
        () => toolWrite(ws, { path: "nope.txt", content: "x", insertAfter: 0 }, creds),
        /ENOENT|does not exist|no such file/i,
      );
    });

    it("errors when insertAfter is out of range", async () => {
      writeFileSync(join(ws, "f.txt"), "aaa\nbbb\n");
      await assert.rejects(
        () => toolWrite(ws, { path: "f.txt", content: "x", insertAfter: 999 }, creds),
        /out of range/,
      );
    });
  });

  // -----------------------------------------------------------------------
  // Auto mkdir -p (mkdirp)
  // -----------------------------------------------------------------------

  describe("mkdirp", () => {
    it("creates parent directories by default", async () => {
      const r = await toolWrite(ws, {
        path: "deep/nested/dir/file.txt", content: "hello\n",
      }, creds);
      assert.equal(readFileSync(join(ws, "deep/nested/dir/file.txt"), "utf8"), "hello\n");
      assert.equal(r.dirCreated, true);
    });

    it("creates parent directories for append mode", async () => {
      await toolWrite(ws, {
        path: "new/path/log.txt", content: "entry\n", append: true,
      }, creds);
      assert.equal(readFileSync(join(ws, "new/path/log.txt"), "utf8"), "entry\n");
    });

    it("does not set dirCreated when dirs already exist", async () => {
      mkdirSync(join(ws, "existing"), { recursive: true });
      const r = await toolWrite(ws, {
        path: "existing/file.txt", content: "hi\n",
      }, creds);
      // dirCreated should be falsy (undefined or false)
      assert.ok(!r.dirCreated);
    });

    it("fails when mkdirp is false and parent dir is missing", async () => {
      await assert.rejects(
        () => toolWrite(ws, {
          path: "no/such/dir/file.txt", content: "x", mkdirp: false,
        }, creds),
        /ENOENT|no such file|failed/i,
      );
    });
  });

  // -----------------------------------------------------------------------
  // Validation / mutual exclusivity
  // -----------------------------------------------------------------------

  describe("validation", () => {
    it("rejects append + startLine together", async () => {
      await assert.rejects(
        () => toolWrite(ws, {
          path: "f.txt", content: "x", append: true, startLine: 1,
        }, creds),
        /Only one write mode/,
      );
    });

    it("rejects append + insertAfter together", async () => {
      await assert.rejects(
        () => toolWrite(ws, {
          path: "f.txt", content: "x", append: true, insertAfter: 0,
        }, creds),
        /Only one write mode/,
      );
    });

    it("rejects startLine + insertAfter together", async () => {
      writeFileSync(join(ws, "f.txt"), "aaa\n");
      await assert.rejects(
        () => toolWrite(ws, {
          path: "f.txt", content: "x", startLine: 1, insertAfter: 0,
        }, creds),
        /Only one write mode/,
      );
    });

    it("rejects endLine without startLine", async () => {
      await assert.rejects(
        () => toolWrite(ws, {
          path: "f.txt", content: "x", endLine: 5,
        }, creds),
        /endLine.*requires.*startLine/,
      );
    });

    it("rejects negative startLine", async () => {
      await assert.rejects(
        () => toolWrite(ws, {
          path: "f.txt", content: "x", startLine: -1,
        }, creds),
        /startLine.*must be >= 1/,
      );
    });

    it("rejects endLine < startLine", async () => {
      await assert.rejects(
        () => toolWrite(ws, {
          path: "f.txt", content: "x", startLine: 5, endLine: 2,
        }, creds),
        /endLine.*must be >= .*startLine/,
      );
    });

    it("rejects negative insertAfter", async () => {
      await assert.rejects(
        () => toolWrite(ws, {
          path: "f.txt", content: "x", insertAfter: -1,
        }, creds),
        /insertAfter.*must be >= 0/,
      );
    });

    it("rejects missing path", async () => {
      await assert.rejects(
        () => toolWrite(ws, { path: "", content: "x" }, creds),
        /path.*required/i,
      );
    });
  });

  // -----------------------------------------------------------------------
  // Binary file rejection for line operations
  // -----------------------------------------------------------------------

  describe("binary file rejection", () => {
    it("rejects line-range replace on binary files", async () => {
      writeFileSync(join(ws, "bin.dat"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x0a]));
      await assert.rejects(
        () => toolWrite(ws, {
          path: "bin.dat", content: "x", startLine: 1,
        }, creds),
        /binary/i,
      );
    });

    it("rejects insertAfter on binary files", async () => {
      writeFileSync(join(ws, "bin.dat"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x0a]));
      await assert.rejects(
        () => toolWrite(ws, {
          path: "bin.dat", content: "x", insertAfter: 0,
        }, creds),
        /binary/i,
      );
    });
  });
});
