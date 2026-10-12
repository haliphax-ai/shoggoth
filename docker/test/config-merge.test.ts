import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = join(repoRoot, "docker", "config-merge.sh");

/** Enough "y" answers to satisfy any number of git hunk prompts after the confirm prompt. */
const ACCEPT_ALL_HUNKS = `y\n${"y\n".repeat(60)}`;

interface Fixture {
  base: string;
  dyn: string;
  cleanup: () => void;
}

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

/** Create an isolated base/dynamic config pair under the OS temp directory. */
function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "config-merge-test-"));
  const base = join(root, "base");
  const dyn = join(root, "dynamic");
  mkdirSync(base, { recursive: true });
  mkdirSync(dyn, { recursive: true });
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return { base, dyn, cleanup: () => {} };
}

function writeJson(dir: string, rel: string, value: unknown): void {
  const full = join(dir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(dir: string, rel: string): unknown {
  return JSON.parse(readFileSync(join(dir, rel), "utf8"));
}

function runMerge(
  action: string,
  fx: Fixture,
  stdin = ACCEPT_ALL_HUNKS,
): { status: number | null; out: string } {
  const res = spawnSync("sh", [script, action], {
    input: stdin,
    encoding: "utf8",
    env: {
      ...process.env,
      SHOGGOTH_BASE_CONFIG_DIR: fx.base,
      SHOGGOTH_DYNAMIC_CONFIG_DIR: fx.dyn,
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  return { status: res.status, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

/** Backup files adjacent to the given base file, e.g. `00-core.json.1712345678.bak`. */
function backupsOf(fx: Fixture, rel: string): string[] {
  const dir = join(fx.base, dirname(rel));
  const base = join(rel).split("/").pop();
  return readdirSync(dir).filter((f) => f.startsWith(`${base}.`) && f.endsWith(".bak"));
}

describe("config-merge.sh", () => {
  it("merges a fragment into the first base file containing the top-most parent property", () => {
    const fx = makeFixture();
    writeJson(fx.base, "00-core.json", {
      logLevel: "info",
      agents: { list: { main: { model: "cheap" } } },
    });
    writeJson(fx.base, "z-other.json", { hitl: { notify: [] } });
    writeJson(fx.dyn, "agents.json", {
      agents: { list: { main: { hitl: { toolAutoApprove: ["builtin-exec"] } } } },
    });

    const res = runMerge("config", fx);
    expect(res.status).toBe(0);

    expect(readJson(fx.base, "00-core.json")).toEqual({
      logLevel: "info",
      agents: { list: { main: { model: "cheap", hitl: { toolAutoApprove: ["builtin-exec"] } } } },
    });
    // untouched file receives no backup
    expect(backupsOf(fx, "z-other.json")).toEqual([]);
    // replaced file is backed up with original content
    const baks = backupsOf(fx, "00-core.json");
    expect(baks).toHaveLength(1);
    expect(baks[0]).toMatch(/^00-core\.json\.\d{10,}\.bak$/);
    expect(JSON.parse(readFileSync(join(fx.base, baks[0]), "utf8"))).toEqual({
      logLevel: "info",
      agents: { list: { main: { model: "cheap" } } },
    });
  });

  it("creates <property name>.json at the base root when no file contains the property", () => {
    const fx = makeFixture();
    writeJson(fx.base, "00-core.json", { logLevel: "info" });
    writeJson(fx.dyn, "memory.json", { memory: { paths: ["memory/*.md"] } });

    const res = runMerge("config", fx);
    expect(res.status).toBe(0);

    expect(readJson(fx.base, "memory.json")).toEqual({ memory: { paths: ["memory/*.md"] } });
    // new file means there was nothing to back up
    expect(backupsOf(fx, "memory.json")).toEqual([]);
    // pre-existing file untouched
    expect(readJson(fx.base, "00-core.json")).toEqual({ logLevel: "info" });
  });

  it("splits a fragment with multiple parent properties across target files", () => {
    const fx = makeFixture();
    writeJson(fx.base, "00-core.json", { logLevel: "info" });
    writeJson(fx.base, "z-extra.json", { hitl: { notify: [] } });
    writeJson(fx.dyn, "multi.json", {
      logLevel: "debug",
      hitl: { requireConfirmation: ["builtin-exec"] },
    });

    const res = runMerge("config", fx);
    expect(res.status).toBe(0);

    expect(readJson(fx.base, "00-core.json")).toEqual({ logLevel: "debug" });
    expect(readJson(fx.base, "z-extra.json")).toEqual({
      hitl: { notify: [], requireConfirmation: ["builtin-exec"] },
    });
  });

  it("replaces arrays and merges nested objects the way the runtime deepMerge does", () => {
    const fx = makeFixture();
    writeJson(fx.base, "a.json", {
      memory: { paths: ["memory/*.md"], extra: true },
    });
    writeJson(fx.dyn, "b.json", { memory: { paths: ["memory/**/*.md"] } });

    const res = runMerge("config", fx);
    expect(res.status).toBe(0);

    expect(readJson(fx.base, "a.json")).toEqual({
      memory: { paths: ["memory/**/*.md"], extra: true },
    });
  });

  it("hitl action merges only persisted approvals; config action skips that file", () => {
    const fx = makeFixture();
    writeJson(fx.base, "00-core.json", { agents: { list: { main: { model: "cheap" } } } });
    writeJson(fx.dyn, "z-hitl-agent-tool-auto-approve.json", {
      agents: { list: { main: { hitl: { toolAutoApprove: ["gh"] } } } },
    });
    writeJson(fx.dyn, "logLevel.json", { logLevel: "debug" });

    const hitl = runMerge("hitl", fx);
    expect(hitl.status).toBe(0);
    expect(readJson(fx.base, "00-core.json")).toEqual({
      agents: { list: { main: { model: "cheap", hitl: { toolAutoApprove: ["gh"] } } } },
    });

    // reset base for the second action
    writeJson(fx.base, "00-core.json", { agents: { list: { main: { model: "cheap" } } } });
    rmSync(join(fx.base, backupsOf(fx, "00-core.json")[0]!));

    const cfg = runMerge("config", fx);
    expect(cfg.status).toBe(0);
    expect(readJson(fx.base, "00-core.json")).toEqual({
      agents: { list: { main: { model: "cheap" } } },
    });
    expect(readJson(fx.base, "logLevel.json")).toEqual({ logLevel: "debug" });
  });

  it("applies only the hunks the operator commits", () => {
    const fx = makeFixture();
    writeJson(fx.base, "00-core.json", { logLevel: "info" });
    writeJson(fx.base, "z-other.json", { memory: { paths: [] } });
    writeJson(fx.dyn, "a-core.json", { logLevel: "debug" });
    writeJson(fx.dyn, "b-other.json", { memory: { paths: ["kept.md"] } });

    // confirm, then accept the 00-core.json hunk and reject the z-other.json hunk
    const res = runMerge("config", fx, `y\ny\nn\n`);
    expect(res.status).toBe(0);

    expect(readJson(fx.base, "00-core.json")).toEqual({ logLevel: "debug" });
    expect(readJson(fx.base, "z-other.json")).toEqual({ memory: { paths: [] } });
    expect(backupsOf(fx, "z-other.json")).toEqual([]);
    // no stray files left behind in the base directory
    expect(readdirSync(fx.base).sort()).toEqual(
      ["00-core.json", "z-other.json", ...backupsOf(fx, "00-core.json")].sort(),
    );
  });

  it("leaves everything untouched when the operator aborts at the confirmation prompt", () => {
    const fx = makeFixture();
    writeJson(fx.base, "00-core.json", { logLevel: "info" });
    writeJson(fx.dyn, "logLevel.json", { logLevel: "debug" });

    const res = runMerge("config", fx, "n\n");
    expect(res.status).toBe(0);
    expect(res.out).toMatch(/abort/i);

    expect(readJson(fx.base, "00-core.json")).toEqual({ logLevel: "info" });
    expect(readdirSync(fx.base)).toEqual(["00-core.json"]);
  });

  it("skips invalid dynamic fragments with a warning and still merges valid ones", () => {
    const fx = makeFixture();
    writeJson(fx.base, "00-core.json", { logLevel: "info" });
    writeFileSync(join(fx.dyn, "bad.json"), "{not json", "utf8");
    writeJson(fx.dyn, "logLevel.json", { logLevel: "warn" });

    const res = runMerge("config", fx);
    expect(res.status).toBe(0);
    expect(res.out).toMatch(/bad\.json/);

    expect(readJson(fx.base, "00-core.json")).toEqual({ logLevel: "warn" });
  });

  it("reports nothing to merge when no dynamic fragments apply", () => {
    const fx = makeFixture();
    writeJson(fx.base, "00-core.json", { logLevel: "info" });

    const res = runMerge("config", fx);
    expect(res.status).toBe(0);
    expect(res.out).toMatch(/nothing to merge/i);
    expect(readdirSync(fx.base)).toEqual(["00-core.json"]);
  });

  it("fails when the dynamic config directory does not exist", () => {
    const fx = makeFixture();
    writeJson(fx.base, "00-core.json", { logLevel: "info" });
    rmSync(fx.dyn, { recursive: true });

    const res = runMerge("config", fx);
    expect(res.status).toBe(1);
  });

  it("fails with usage on an unknown action", () => {
    const fx = makeFixture();
    const res = runMerge("bogus", fx);
    expect(res.status).toBe(2);
    expect(res.out).toMatch(/usage/i);
  });
});
