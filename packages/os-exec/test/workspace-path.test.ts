import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { PathEscapeError, resolvePathForRead, resolvePathForWrite } from "../src/workspace-path";

describe("workspace path allowlist", () => {
  let ws: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "shoggoth-ws-"));
  });

  afterEach(() => {
    rmSync(ws, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  describe("relative paths", () => {
    it("resolves a file inside workspace for read", () => {
      mkdirSync(join(ws, "sub"), { recursive: true });
      writeFileSync(join(ws, "sub/hello.txt"), "hi");
      const p = resolvePathForRead(ws, "sub/hello.txt");
      assert.ok(p.endsWith("hello.txt"));
    });

    it("rejects traversal outside workspace", () => {
      writeFileSync(join(ws, "a.txt"), "x");
      assert.throws(() => resolvePathForRead(ws, ".."), PathEscapeError);
      assert.throws(() => resolvePathForRead(ws, "../../.."), PathEscapeError);
    });

    it("resolvePathForWrite rejects traversal and allows new file under workspace", () => {
      mkdirSync(join(ws, "d"), { recursive: true });
      const p = resolvePathForWrite(ws, "d/new.txt");
      assert.ok(p.includes("d"));
      assert.ok(p.endsWith("new.txt"));
      assert.throws(() => resolvePathForWrite(ws, "../../../tmp/x"), PathEscapeError);
    });

    it("rejects symlink escape to outside path on read", () => {
      const outside = mkdtempSync(join(tmpdir(), "shoggoth-out-"));
      try {
        writeFileSync(join(outside, "secret"), "nope");
        symlinkSync(join(outside, "secret"), join(ws, "link"));
        assert.throws(() => resolvePathForRead(ws, "link"), PathEscapeError);
      } finally {
        rmSync(outside, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    });
  });

  describe("absolute paths", () => {
    it("accepts absolute paths within workspace for read", () => {
      mkdirSync(join(ws, "sub"), { recursive: true });
      writeFileSync(join(ws, "sub/hello.txt"), "hi");
      const absPath = resolve(ws, "sub/hello.txt");
      const p = resolvePathForRead(ws, absPath);
      assert.ok(p.endsWith("hello.txt"));
    });

    it("accepts absolute paths within workspace for write", () => {
      mkdirSync(join(ws, "d"), { recursive: true });
      const absPath = resolve(ws, "d/new.txt");
      const p = resolvePathForWrite(ws, absPath);
      assert.ok(p.includes("d"));
      assert.ok(p.endsWith("new.txt"));
    });

    it("rejects absolute paths outside workspace for read", () => {
      const outside = mkdtempSync(join(tmpdir(), "shoggoth-out-"));
      try {
        writeFileSync(join(outside, "secret"), "nope");
        assert.throws(() => resolvePathForRead(ws, join(outside, "secret")), PathEscapeError);
      } finally {
        rmSync(outside, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    });

    it("rejects absolute paths outside workspace for write", () => {
      const outside = mkdtempSync(join(tmpdir(), "shoggoth-out-"));
      try {
        assert.throws(() => resolvePathForWrite(ws, join(outside, "new.txt")), PathEscapeError);
      } finally {
        rmSync(outside, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    });

    it("rejects absolute symlink escape to outside path on read", () => {
      const outside = mkdtempSync(join(tmpdir(), "shoggoth-out-"));
      try {
        writeFileSync(join(outside, "secret"), "nope");
        symlinkSync(join(outside, "secret"), join(ws, "link"));
        const absLink = resolve(ws, "link");
        assert.throws(() => resolvePathForRead(ws, absLink), PathEscapeError);
      } finally {
        rmSync(outside, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    });
  });

  describe("additional read roots (/app)", () => {
    let appDir: string;

    beforeEach(() => {
      appDir = mkdtempSync(join(tmpdir(), "shoggoth-app-"));
      mkdirSync(join(appDir, "packages/shared/src"), { recursive: true });
      writeFileSync(join(appDir, "packages/shared/src/schema.ts"), "export type Schema = {}");
      writeFileSync(join(appDir, "README.md"), "hello");
    });

    afterEach(() => {
      rmSync(appDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    });

    it("accepts paths under an additional read root", () => {
      const p = resolvePathForRead(ws, join(appDir, "packages/shared/src/schema.ts"), [appDir]);
      assert.ok(p.endsWith("schema.ts"));
    });

    it("accepts the additional read root directory itself", () => {
      const p = resolvePathForRead(ws, appDir, [appDir]);
      assert.strictEqual(p, realpathSync(appDir));
    });

    it("rejects traversal escaping the additional read root", () => {
      assert.throws(
        () => resolvePathForRead(ws, join(appDir, "../etc/passwd"), [appDir]),
        PathEscapeError,
      );
    });

    it("rejects traversal via double-dot from additional read root", () => {
      assert.throws(() => resolvePathForRead(ws, join(appDir, ".."), [appDir]), PathEscapeError);
    });

    it("rejects symlink escape from additional read root", () => {
      const outside = mkdtempSync(join(tmpdir(), "shoggoth-out-"));
      try {
        writeFileSync(join(outside, "secret"), "nope");
        symlinkSync(join(outside, "secret"), join(appDir, "escape-link"));
        assert.throws(
          () => resolvePathForRead(ws, join(appDir, "escape-link"), [appDir]),
          PathEscapeError,
        );
      } finally {
        rmSync(outside, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    });

    it("still allows workspace-relative paths when additional roots are set", () => {
      mkdirSync(join(ws, "sub"), { recursive: true });
      writeFileSync(join(ws, "sub/hello.txt"), "hi");
      const p = resolvePathForRead(ws, "sub/hello.txt", [appDir]);
      assert.ok(p.endsWith("hello.txt"));
    });

    it("resolvePathForWrite rejects paths under additional read root", () => {
      assert.throws(
        () => resolvePathForWrite(ws, join(appDir, "packages/shared/src/schema.ts")),
        PathEscapeError,
      );
    });

    it("uses /app as default additional read root", () => {
      // When no additionalReadRoots argument is passed, /app should be the default.
      // We can't easily test this without /app existing, but we verify the signature
      // accepts the call without the third argument (existing behavior preserved).
      mkdirSync(join(ws, "sub"), { recursive: true });
      writeFileSync(join(ws, "sub/file.txt"), "data");
      const p = resolvePathForRead(ws, "sub/file.txt");
      assert.ok(p.endsWith("file.txt"));
    });
  });

  describe("symlink cycle handling", () => {
    it("handles write through a self-referencing symlink inside workspace", () => {
      // Create a symlink that points back to its parent directory
      mkdirSync(join(ws, "a"), { recursive: true });
      symlinkSync(join(ws, "a"), join(ws, "a/link"));
      // Writing through the symlink should resolve to a path inside workspace
      const p = resolvePathForWrite(ws, join(ws, "a/link/new.txt"));
      assert.ok(p.endsWith("new.txt"));
    });

    it("rejects write through a symlink that escapes workspace", () => {
      const outside = mkdtempSync(join(tmpdir(), "shoggoth-out-"));
      try {
        writeFileSync(join(outside, "secret"), "nope");
        symlinkSync(join(outside, "secret"), join(ws, "escape-link"));
        assert.throws(
          () => resolvePathForWrite(ws, join(ws, "escape-link/new.txt")),
          PathEscapeError,
        );
      } finally {
        rmSync(outside, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    });
  });

  describe("NUL byte rejection", () => {
    it("rejects paths with NUL bytes", () => {
      assert.throws(() => resolvePathForRead(ws, "file\0name"), PathEscapeError);
      assert.throws(() => resolvePathForWrite(ws, "file\0name"), PathEscapeError);
    });
  });
});
