import { describe, it, vi, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mockInvoke = vi.fn();
vi.mock("@shoggoth/daemon/lib", () => ({
  invokeControlRequest: (...args: unknown[]) => mockInvoke(...args),
  resolveSessionTargetFromCliArg: (raw: string) => `agent:resolved:${raw}`,
}));

const mockLoadLayeredConfig = vi.fn().mockReturnValue({ socketPath: "/tmp/test.sock" });
vi.mock("@shoggoth/shared", () => ({
  loadLayeredConfigAsync: (...args: unknown[]) => mockLoadLayeredConfig(...args),
  LAYOUT: { configDir: "/tmp/cfg" },
  VERSION: "0.0.0-test",
}));

import { parsePromptArgs, runPromptCli } from "../src/run-prompt";

let logged: string[] = [];
let errored: string[] = [];
const origLog = console.log;
const origErr = console.error;

beforeEach(() => {
  logged = [];
  errored = [];
  console.log = (...args: unknown[]) => logged.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => errored.push(args.map(String).join(" "));
  process.exitCode = undefined;
  process.env.SHOGGOTH_OPERATOR_TOKEN = "test-token";
  process.env.SHOGGOTH_CONTROL_SOCKET = "/tmp/test.sock";
  mockInvoke.mockReset();
  mockLoadLayeredConfig.mockReset().mockReturnValue({ socketPath: "/tmp/test.sock" });
});

afterEach(() => {
  console.log = origLog;
  console.error = origErr;
  delete process.env.SHOGGOTH_OPERATOR_TOKEN;
  delete process.env.SHOGGOTH_CONTROL_SOCKET;
});

describe("parsePromptArgs", () => {
  it("parses slug, session, and name=value arguments", () => {
    const result = parsePromptArgs([
      "triage",
      "--session",
      "agent:main",
      "cardId=F-12",
      "note=hello world",
    ]);
    assert.ok(result.ok);
    assert.strictEqual(result.payload.slug, "triage");
    assert.deepStrictEqual(result.payload.params, { cardId: "F-12", note: "hello world" });
    assert.strictEqual(result.sessionTarget, "agent:main");
  });

  it("parses an inline JSON blob", () => {
    const result = parsePromptArgs([
      "triage",
      "--session",
      "s1",
      "--json",
      '{"cardId":"F-9","count":3}',
    ]);
    assert.ok(result.ok);
    assert.deepStrictEqual(result.payload.params, { cardId: "F-9", count: "3" });
  });

  it("rejects malformed JSON blobs", () => {
    const result = parsePromptArgs(["triage", "--session", "s1", "--json", "{nope"]);
    assert.strictEqual(result.ok, false);
    if (!result.ok) assert.ok(result.error.includes("--json"));
  });

  it("rejects non-object JSON blobs", () => {
    const result = parsePromptArgs(["triage", "--session", "s1", "--json", "[1,2]"]);
    assert.strictEqual(result.ok, false);
  });

  it("reads params from a JSON file", () => {
    const dir = mkdtempSync(join(tmpdir(), "run-prompt-"));
    try {
      const file = join(dir, "params.json");
      writeFileSync(file, JSON.stringify({ fileKey: "from-file" }));
      const result = parsePromptArgs(["triage", "--session", "s1", "--json-file", file]);
      assert.ok(result.ok);
      assert.deepStrictEqual(result.payload.params, { fileKey: "from-file" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("merges all three sources with name=value winning last", () => {
    const dir = mkdtempSync(join(tmpdir(), "run-prompt-"));
    try {
      const file = join(dir, "params.json");
      writeFileSync(file, JSON.stringify({ a: "file", b: "file", c: "file" }));
      const result = parsePromptArgs([
        "triage",
        "--session",
        "s1",
        "--json-file",
        file,
        "--json",
        '{"b":"blob","c":"blob"}',
        "c=arg",
        "d=",
      ]);
      assert.ok(result.ok);
      assert.deepStrictEqual(result.payload.params, {
        a: "file",
        b: "blob",
        c: "arg",
        d: "",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires a slug", () => {
    const result = parsePromptArgs(["--session", "s1"]);
    assert.strictEqual(result.ok, false);
    if (!result.ok) assert.ok(result.error.includes("slug"));
  });

  it("requires --session", () => {
    const result = parsePromptArgs(["triage"]);
    assert.strictEqual(result.ok, false);
    if (!result.ok) assert.ok(result.error.includes("--session"));
  });

  it("rejects unknown flags without =", () => {
    const result = parsePromptArgs(["triage", "--session", "s1", "--bogus"]);
    assert.strictEqual(result.ok, false);
    if (!result.ok) assert.ok(result.error.includes("--bogus"));
  });

  it("rejects positional tokens without =", () => {
    const result = parsePromptArgs(["triage", "--session", "s1", "oops"]);
    assert.strictEqual(result.ok, false);
    if (!result.ok) assert.ok(result.error.includes("name=value"));
  });

  it("passes --silent through", () => {
    const result = parsePromptArgs(["triage", "--session", "s1", "--silent"]);
    assert.ok(result.ok);
    assert.strictEqual(result.payload.silent, true);
  });
});

describe("runPromptCli", () => {
  it("sends the prompt op with resolved session and merged params", async () => {
    mockInvoke.mockResolvedValue({ ok: true, result: { reply: "done" } });
    await runPromptCli(["triage", "--session", "main", "cardId=F-1"]);
    assert.strictEqual(mockInvoke.mock.calls.length, 1);
    const call = mockInvoke.mock.calls[0][0]!;
    assert.strictEqual(call.op, "prompt");
    assert.strictEqual(call.payload.session_id, "agent:resolved:main");
    assert.strictEqual(call.payload.slug, "triage");
    assert.deepStrictEqual(call.payload.params, { cardId: "F-1" });
    assert.ok(logged.join("\n").includes("done"));
    assert.strictEqual(process.exitCode, undefined);
  });

  it("surfaces daemon errors and sets exit code", async () => {
    mockInvoke.mockResolvedValue({
      ok: false,
      error: { code: "ERR_MISSING_PROMPT_PARAMS", message: "missing prompt parameters: cardId" },
    });
    await runPromptCli(["triage", "--session", "main"]);
    assert.strictEqual(process.exitCode, 1);
    const out = logged.join("\n");
    assert.ok(out.includes("missing prompt parameters: cardId"));
  });
});
