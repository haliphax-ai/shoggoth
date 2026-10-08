import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BuiltinToolContext } from "../../src/sessions/builtin-tool-registry";
import { BuiltinToolRegistry } from "../../src/sessions/builtin-tool-registry";
import { register, validateJqFilter } from "../../src/sessions/builtin-handlers/logs-handler";
import { defaultConfig, type ShoggothConfig } from "@shoggoth/shared";

const jqAvailable = spawnSync("jq", ["--version"], { stdio: "ignore" }).status === 0;

function utcStamp(offsetDays: number): string {
  return new Date(Date.now() - offsetDays * 86_400_000).toISOString().slice(0, 10);
}

function makeCtx(config: ShoggothConfig): BuiltinToolContext {
  return {
    sessionId: "agent:test:discord:channel:123",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: {} as any,
    config,
    env: process.env,
    workspacePath: "/tmp",
    workspaceRealPath: "/tmp",
    creds: { uid: 900, gid: 900 },
    orchestratorEnv: process.env,
    getAgentIntegrationInvoker: () => undefined,
    getProcessManager: () => undefined,
    messageToolCtx: undefined,
    memoryConfig: config.memory,
    runtimeOpenaiBaseUrl: undefined,
    isSubagentSession: false,
  };
}

function makeConfig(logDir: string): ShoggothConfig {
  return {
    ...defaultConfig("/tmp/cfg"),
    logging: { file: { enabled: true, dir: logDir, maxQueue: 1_000, maxFiles: 7 } },
  } as ShoggothConfig;
}

describe("logs-handler", () => {
  let registry: BuiltinToolRegistry;
  let logDir: string;

  beforeEach(() => {
    registry = new BuiltinToolRegistry();
    register(registry);
    logDir = mkdtempSync(join(tmpdir(), "shoggoth-logshandler-"));
  });

  afterEach(() => {
    rmSync(logDir, { recursive: true, force: true });
  });

  describe("validateJqFilter", () => {
    it("rejects empty filters", () => {
      expect(validateJqFilter("")).toBeTruthy();
      expect(validateJqFilter("   ")).toBeTruthy();
    });

    it("rejects over-long filters", () => {
      expect(validateJqFilter("a".repeat(2_001))).toBeTruthy();
    });

    it("rejects unbalanced brackets", () => {
      expect(validateJqFilter("{")).toBeTruthy();
      expect(validateJqFilter(".a | [1, 2")).toBeTruthy();
      expect(validateJqFilter(".a)")).toBeTruthy();
    });

    it("rejects unterminated string literals", () => {
      expect(validateJqFilter('select(.a == "b')).toBeTruthy();
    });

    it("accepts well-formed filters", () => {
      expect(validateJqFilter('. | select(.level == "error")')).toBeUndefined();
      expect(validateJqFilter("{ts, msg}")).toBeUndefined();
      expect(validateJqFilter('select(.msg | test("a\'b"))')).toBeUndefined();
    });
  });

  it("rejects a missing filter", async () => {
    const result = await registry.execute("logs", {}, makeCtx(makeConfig(logDir)));
    expect(JSON.parse(result.resultJson)).toEqual({ error: "filter is required" });
  });

  it("rejects a non-string filter", async () => {
    const result = await registry.execute("logs", { filter: 42 }, makeCtx(makeConfig(logDir)));
    expect(JSON.parse(result.resultJson)).toEqual({ error: "filter is required" });
  });

  it("rejects a filter with unbalanced brackets", async () => {
    const result = await registry.execute("logs", { filter: "{" }, makeCtx(makeConfig(logDir)));
    expect(JSON.parse(result.resultJson)).toEqual({ error: "filter has unbalanced brackets" });
  });

  it("returns an error when no log files exist in the window", async () => {
    const result = await registry.execute("logs", { filter: "." }, makeCtx(makeConfig(logDir)));
    const parsed = JSON.parse(result.resultJson);
    expect(parsed.error).toMatch(/no log files found/);
    expect(parsed.days).toBe(1);
  });

  describe.skipIf(!jqAvailable)("jq execution", () => {
    it("filters the current day's log file", async () => {
      writeFileSync(
        join(logDir, `shoggoth-${utcStamp(0)}.log`),
        [
          JSON.stringify({ ts: "t1", level: "info", msg: "hello" }),
          JSON.stringify({ ts: "t2", level: "error", msg: "boom" }),
          JSON.stringify({ ts: "t3", level: "error", msg: "kaboom" }),
          "",
        ].join("\n"),
      );

      const result = await registry.execute(
        "logs",
        { filter: 'select(.level == "error") | .msg' },
        makeCtx(makeConfig(logDir)),
      );
      const parsed = JSON.parse(result.resultJson);
      expect(parsed.output.trim().split("\n")).toEqual(['"boom"', '"kaboom"']);
    });

    it("reads rotated .log.gz archives within the requested window", async () => {
      writeFileSync(
        join(logDir, `shoggoth-${utcStamp(1)}.log.gz`),
        gzipSync(Buffer.from(JSON.stringify({ level: "warn", msg: "from archive" }) + "\n")),
      );

      const result = await registry.execute(
        "logs",
        { filter: 'select(.level == "warn") | .msg', days: 2 },
        makeCtx(makeConfig(logDir)),
      );
      const parsed = JSON.parse(result.resultJson);
      expect(parsed.output.trim()).toBe('"from archive"');
    });

    it("honors the tail line window", async () => {
      const lines: string[] = [];
      for (let i = 0; i < 10; i++) {
        lines.push(JSON.stringify({ n: i }));
      }
      writeFileSync(join(logDir, `shoggoth-${utcStamp(0)}.log`), lines.join("\n") + "\n");

      const result = await registry.execute(
        "logs",
        { filter: ".n", tail: 3 },
        makeCtx(makeConfig(logDir)),
      );
      const parsed = JSON.parse(result.resultJson);
      expect(parsed.output.trim().split("\n")).toEqual(["7", "8", "9"]);
    });

    it("surfaces jq compile errors", async () => {
      writeFileSync(join(logDir, `shoggoth-${utcStamp(0)}.log`), '{"n":1}\n');
      const result = await registry.execute(
        "logs",
        { filter: ".foo |" },
        makeCtx(makeConfig(logDir)),
      );
      const parsed = JSON.parse(result.resultJson);
      expect(parsed.error).toBeTruthy();
      expect(String(parsed.error)).toMatch(/error|syntax|compile/i);
    });
  });
});
