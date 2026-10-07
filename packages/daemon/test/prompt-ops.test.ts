import { describe, it, before, after } from "vitest";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_GLOBAL_PROMPTS_DIR,
  listPromptFiles,
  PromptOpError,
  renderPrompt,
  resolvePromptFile,
  scanPromptPlaceholders,
} from "../src/control/prompt-ops";

describe("prompt-ops", () => {
  let root: string;
  let workspace: string;
  let globalDir: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "prompt-ops-"));
    workspace = join(root, "ws");
    globalDir = join(root, "global");
    mkdirSync(join(workspace, "prompts"), { recursive: true });
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(workspace, "prompts", "local.md"), "Hi ${name}, card ${cardId}/${cardId}.");
    writeFileSync(join(workspace, "root.md"), "workspace root prompt");
    writeFileSync(join(globalDir, "shared.md"), "Global for ${who}");
    writeFileSync(join(globalDir, "local.md"), "global shadow — should lose to workspace");
    writeFileSync(join(globalDir, "shadow-root.md"), "root also wins");
    writeFileSync(join(workspace, "shadow-root.md"), "workspace root wins over global");
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe("scanPromptPlaceholders", () => {
    it("collects unique names in first-appearance order", () => {
      assert.deepStrictEqual(
        scanPromptPlaceholders("a ${first} b ${second} c ${first} d ${third}"),
        ["first", "second", "third"],
      );
    });

    it("returns empty for prompts without placeholders", () => {
      assert.deepStrictEqual(scanPromptPlaceholders("no params here ${not a name}"), []);
    });
  });

  describe("renderPrompt", () => {
    it("interpolates values including empty strings", () => {
      assert.strictEqual(
        renderPrompt("X ${a} Y ${b} Z", { a: "", b: "bee" }),
        "X  Y bee Z",
      );
    });

    it("lists every missing parameter name in the error", () => {
      assert.throws(
        () => renderPrompt("${one} and ${two} and ${three}", { one: "1", three: "3" }),
        (e: unknown) => {
          assert.ok(e instanceof PromptOpError);
          assert.strictEqual(e.code, "ERR_MISSING_PROMPT_PARAMS");
          assert.ok(e.message.includes("two"));
          assert.ok(!e.message.includes("one"));
          return true;
        },
      );
    });

    it("empty-string params count as provided", () => {
      assert.strictEqual(renderPrompt("v=${v}", { v: "" }), "v=");
    });
  });

  describe("resolvePromptFile", () => {
    it("resolves workspace prompts/ before workspace root before global", () => {
      assert.strictEqual(
        resolvePromptFile(workspace, globalDir, "local"),
        join(workspace, "prompts", "local.md"),
      );
      assert.strictEqual(
        resolvePromptFile(workspace, globalDir, "shadow-root"),
        join(workspace, "shadow-root.md"),
      );
      assert.strictEqual(
        resolvePromptFile(workspace, globalDir, "shared"),
        join(globalDir, "shared.md"),
      );
    });

    it("resolves from global when no workspace is given", () => {
      assert.strictEqual(resolvePromptFile(undefined, globalDir, "shared"), join(globalDir, "shared.md"));
    });

    it("uses the default global dir when unconfigured", () => {
      assert.strictEqual(DEFAULT_GLOBAL_PROMPTS_DIR, "/var/lib/shoggoth/shared/prompts");
    });

    it("returns undefined when not found anywhere", () => {
      assert.strictEqual(resolvePromptFile(workspace, globalDir, "missing"), undefined);
    });

    it("rejects traversal slugs", () => {
      assert.throws(
        () => resolvePromptFile(workspace, globalDir, "../evil"),
        (e: unknown) => e instanceof PromptOpError && e.code === "ERR_INVALID_PAYLOAD",
      );
      assert.throws(
        () => resolvePromptFile(workspace, globalDir, "a/b"),
        (e: unknown) => e instanceof PromptOpError && e.code === "ERR_INVALID_PAYLOAD",
      );
    });
  });

  describe("listPromptFiles", () => {
    it("unions workspace + global, dedupes by slug (workspace wins), sorts by slug", () => {
      const entries = listPromptFiles(workspace, globalDir);
      const bySlug = Object.fromEntries(entries.map((e) => [e.slug, e]));
      assert.deepStrictEqual(
        entries.map((e) => e.slug),
        [...entries.map((e) => e.slug)].sort(),
      );
      assert.strictEqual(bySlug["local"]!.source, "workspace");
      assert.strictEqual(bySlug["shadow-root"]!.source, "workspace");
      assert.strictEqual(bySlug["shared"]!.source, "global");
      assert.strictEqual(bySlug["root"]!.source, "workspace");
      assert.deepStrictEqual(bySlug["local"]!.placeholders, ["name", "cardId"]);
      assert.deepStrictEqual(bySlug["shared"]!.placeholders, ["who"]);
    });

    it("lists global-only when workspace is undefined", () => {
      const entries = listPromptFiles(undefined, globalDir);
      assert.deepStrictEqual(
        entries.map((e) => e.slug),
        ["local", "shared", "shadow-root"],
      );
      assert.ok(entries.every((e) => e.source === "global"));
    });
  });
});
