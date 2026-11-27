import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { toolRead, toolWrite, toolExec, logBashEnvWritable } from "../src/tools";
import { createLogger, setRootLogger, type Logger, type LogFields } from "@shoggoth/shared";

type RecordedLog = { level: string; msg: string; fields?: Record<string, unknown> };

/** Install a recording root logger and return its captured records. */
function recordingLogger(): RecordedLog[] {
  const logs: RecordedLog[] = [];
  const record = (level: string) => (msg: string, fields?: LogFields) => {
    logs.push({ level, msg, fields });
  };
  const logger = {
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    child: () => logger,
  } as unknown as Logger;
  setRootLogger(logger);
  return logs;
}

const defaultLogger = createLogger({ component: "tools.test" });

describe("minimal v1 tools (read / write / exec)", () => {
  let ws: string;
  const creds = { uid: process.getuid(), gid: process.getgid() };

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "shoggoth-tools-"));
  });

  afterEach(() => {
    setRootLogger(defaultLogger);
    rmSync(ws, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("toolRead returns file contents via dropped-priv child", async () => {
    mkdirSync(join(ws, "a"), { recursive: true });
    writeFileSync(join(ws, "a/b.txt"), "hello-tools");
    const text = await toolRead(ws, "a/b.txt", creds);
    assert.equal(text, "hello-tools");
  });

  it("toolWrite creates file as agent uid", async () => {
    await toolWrite(ws, { path: "out.txt", content: "wrote\n" }, creds);
    assert.equal(readFileSync(join(ws, "out.txt"), "utf8"), "wrote\n");
  });

  it("toolExec runs binary with cwd in workspace", async () => {
    const r = await toolExec(ws, ["/bin/pwd"], creds);
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.trim().length > 0);
  });

  it("toolRead rejects paths outside workspace allowlist", async () => {
    writeFileSync(join(ws, "ok.txt"), "ok");
    await assert.rejects(() => toolRead(ws, "..", creds));
  });

  it("toolExec points BASH_ENV at the workspace .bashrc and flags it agent-writable", async () => {
    const logs = recordingLogger();
    const r = await toolExec(ws, ["/bin/bash", "-c", "echo $BASH_ENV"], creds);
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout.trim(), join(ws, ".bashrc"));
    assert.ok(
      !r.stderr.includes("/bin/bash:"),
      `BASH_ENV handling must stay silent, got stderr: ${r.stderr.trim()}`,
    );
    assert.ok(
      logs.some((l) => l.level === "error" && l.msg.includes("BASH_ENV")),
      `expected an agent-writable BASH_ENV error, got: ${JSON.stringify(logs)}`,
    );
  });

  it("logBashEnvWritable stays silent when the target is not agent-writable", () => {
    const logs = recordingLogger();
    logBashEnvWritable("/etc/hosts");
    assert.ok(
      !logs.some((l) => l.level === "error" && l.msg.includes("BASH_ENV")),
      `expected no BASH_ENV error, got: ${JSON.stringify(logs)}`,
    );
  });
});
