import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { ManagedProcess } from "../src/managed-process.js";
import type { ProcessSpec } from "../src/types.js";

function makeSpec(overrides: Partial<ProcessSpec> = {}): ProcessSpec {
  return {
    id: "test-proc",
    owner: { kind: "daemon" },
    command: "echo",
    args: ["hello"],
    restart: { mode: "never" },
    ...overrides,
  };
}

describe("ManagedProcess", () => {
  it("starts and transitions to running then dead for a short-lived process", async () => {
    const mp = new ManagedProcess(makeSpec());
    const states: string[] = [];
    mp.on("state-change", (s: string) => states.push(s));

    await mp.start();

    // echo exits immediately — wait for it to finish
    await new Promise<void>((resolve) => {
      if (mp.state === "dead") return resolve();
      mp.on("state-change", (s: string) => {
        if (s === "dead") resolve();
      });
    });

    assert.equal(mp.state, "dead");
    assert.ok(states.includes("running"), "should have transitioned through running");
    assert.ok(states.includes("dead"), "should have reached dead");
    assert.equal(mp.lastExitCode, 0);
  });

  it("captures stdout output", async () => {
    const mp = new ManagedProcess(makeSpec({
      command: "echo",
      args: ["captured-output"],
    }));

    await mp.start();
    await new Promise<void>((resolve) => {
      if (mp.state === "dead") return resolve();
      mp.on("state-change", (s: string) => {
        if (s === "dead") resolve();
      });
    });

    const output = mp.readOutput("stdout");
    assert.ok(output.includes("captured-output"), `stdout should contain 'captured-output', got: ${output}`);
  });

  it("restarts on failure with on-failure policy", async () => {
    const mp = new ManagedProcess(makeSpec({
      id: "restart-test",
      command: "sh",
      args: ["-c", "exit 1"],
      restart: {
        mode: "on-failure",
        maxRetries: 2,
        initialDelayMs: 50,
        backoffMultiplier: 1,
        maxDelayMs: 100,
      },
    }));

    await mp.start();

    // Wait for it to exhaust retries and go dead
    await new Promise<void>((resolve) => {
      const check = () => {
        if (mp.state === "dead") return resolve();
        mp.on("state-change", (s: string) => {
          if (s === "dead") resolve();
        });
      };
      check();
    });

    assert.equal(mp.state, "dead");
    assert.ok(mp.restartCount >= 1, `should have restarted at least once, got ${mp.restartCount}`);
  });

  it("does not restart with never policy", async () => {
    const mp = new ManagedProcess(makeSpec({
      command: "sh",
      args: ["-c", "exit 1"],
      restart: { mode: "never" },
    }));

    await mp.start();
    await new Promise<void>((resolve) => {
      if (mp.state === "dead") return resolve();
      mp.on("state-change", (s: string) => {
        if (s === "dead") resolve();
      });
    });

    assert.equal(mp.state, "dead");
    assert.equal(mp.restartCount, 0);
    assert.equal(mp.lastExitCode, 1);
  });

  it("graceful stop sends signal and transitions to dead", async () => {
    const mp = new ManagedProcess(makeSpec({
      id: "stop-test",
      command: "sleep",
      args: ["60"],
      restart: { mode: "never" },
      shutdown: { signal: "SIGTERM", graceMs: 2000 },
    }));

    await mp.start();
    assert.equal(mp.state, "running");
    assert.ok(mp.pid != null, "should have a PID");

    await mp.stop();
    assert.equal(mp.state, "dead");
  });

  it("kill force-kills the process", async () => {
    const mp = new ManagedProcess(makeSpec({
      id: "kill-test",
      command: "sleep",
      args: ["60"],
      restart: { mode: "never" },
    }));

    await mp.start();
    assert.equal(mp.state, "running");

    mp.kill();

    await new Promise<void>((resolve) => {
      if (mp.state === "dead") return resolve();
      mp.on("state-change", (s: string) => {
        if (s === "dead") resolve();
      });
    });

    assert.equal(mp.state, "dead");
    assert.equal(mp.lastSignal, "SIGKILL");
  });

  it("stdout-match health check transitions to running on match", async () => {
    const mp = new ManagedProcess(makeSpec({
      id: "health-stdout",
      command: "sh",
      args: ["-c", "echo 'READY'; sleep 60"],
      restart: { mode: "never" },
      health: { kind: "stdout-match", pattern: "READY", timeoutMs: 5000 },
    }));

    await mp.start();
    assert.equal(mp.state, "running");

    await mp.stop();
  });

  it("emits exit event with code and signal", async () => {
    const mp = new ManagedProcess(makeSpec({
      command: "sh",
      args: ["-c", "exit 42"],
      restart: { mode: "never" },
    }));

    const exitInfo = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      mp.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
        resolve({ code, signal });
      });
      mp.start();
    });

    assert.equal(exitInfo.code, 42);
  });
});
