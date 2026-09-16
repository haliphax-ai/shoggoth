import { describe, it, afterEach } from "vitest";
import assert from "node:assert/strict";
import * as net from "node:net";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
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

function makeRunningSpec(overrides: Partial<ProcessSpec> = {}): ProcessSpec {
  return makeSpec({
    id: "long-proc",
    command: "sleep",
    args: ["60"],
    ...overrides,
  });
}

function waitForState(mp: ManagedProcess, target: string, timeoutMs = 10000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (mp.state === target) return resolve();
    const timer = setTimeout(
      () => reject(new Error(`Timeout waiting for state ${target}`)),
      timeoutMs,
    );
    mp.on("state-change", (s: string) => {
      if (s === target) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

let cleanupTmpFiles: string[] = [];

afterEach(() => {
  for (const f of cleanupTmpFiles) {
    try {
      fs.unlinkSync(f);
    } catch {
      // ignore
    }
  }
  cleanupTmpFiles = [];
});

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
    const mp = new ManagedProcess(
      makeSpec({
        command: "echo",
        args: ["captured-output"],
      }),
    );

    await mp.start();
    await new Promise<void>((resolve) => {
      if (mp.state === "dead") return resolve();
      mp.on("state-change", (s: string) => {
        if (s === "dead") resolve();
      });
    });

    const output = mp.readOutput("stdout");
    assert.ok(
      output.includes("captured-output"),
      `stdout should contain 'captured-output', got: ${output}`,
    );
  });

  it("restarts on failure with on-failure policy", async () => {
    const mp = new ManagedProcess(
      makeSpec({
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
      }),
    );

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
    const mp = new ManagedProcess(
      makeSpec({
        command: "sh",
        args: ["-c", "exit 1"],
        restart: { mode: "never" },
      }),
    );

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
    const mp = new ManagedProcess(
      makeSpec({
        id: "stop-test",
        command: "sleep",
        args: ["60"],
        restart: { mode: "never" },
        shutdown: { signal: "SIGTERM", graceMs: 2000 },
      }),
    );

    await mp.start();
    assert.equal(mp.state, "running");
    assert.ok(mp.pid != null, "should have a PID");

    await mp.stop();
    assert.equal(mp.state, "dead");
  });

  it("kill force-kills the process", async () => {
    const mp = new ManagedProcess(
      makeSpec({
        id: "kill-test",
        command: "sleep",
        args: ["60"],
        restart: { mode: "never" },
      }),
    );

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
    const mp = new ManagedProcess(
      makeSpec({
        id: "health-stdout",
        command: "sh",
        args: ["-c", "echo 'READY'; sleep 60"],
        restart: { mode: "never" },
        health: { kind: "stdout-match", pattern: "READY", timeoutMs: 5000 },
      }),
    );

    await mp.start();
    assert.equal(mp.state, "running");

    await mp.stop();
  });

  it("emits exit event with code and signal", async () => {
    const mp = new ManagedProcess(
      makeSpec({
        command: "sh",
        args: ["-c", "exit 42"],
        restart: { mode: "never" },
      }),
    );

    const exitInfo = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      mp.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
        resolve({ code, signal });
      });
      mp.start();
    });

    assert.equal(exitInfo.code, 42);
  });

  // ===========================================================================
  // NEW TESTS — TCP, HTTP, and exec health check probes
  // ===========================================================================

  describe("health check probes", () => {
    describe("_probeTcp", () => {
      it("succeeds when TCP server is listening on the port", async () => {
        // Start a TCP server on an ephemeral port
        const server = net.createServer();
        const port = await new Promise<number>((resolve) => {
          server.listen(0, "127.0.0.1", () => {
            const addr = server.address();
            resolve(typeof addr === "object" && addr ? addr.port : 0);
          });
        });

        try {
          const mp = new ManagedProcess(
            makeRunningSpec({
              id: "tcp-pass",
              health: { kind: "tcp", port, host: "127.0.0.1", retries: 3, intervalMs: 100 },
            }),
          );

          await mp.start();
          assert.equal(mp.state, "running", "should transition to running when TCP probe succeeds");
          await mp.stop();
        } finally {
          server.close();
        }
      });

      it("fails and retries when no server is listening", async () => {
        const mp = new ManagedProcess(
          makeRunningSpec({
            id: "tcp-fail",
            health: {
              kind: "tcp",
              port: 59999,
              host: "127.0.0.1",
              retries: 2,
              intervalMs: 50,
              timeoutMs: 200,
            },
          }),
        );

        await assert.rejects(() => mp.start(), /health check failed for tcp-fail/);

        // Process should be in failed state
        assert.equal(mp.state, "failed");
      });
    });

    describe("_probeHttp", () => {
      it("succeeds when HTTP server returns expected status", async () => {
        const server = http.createServer((_req, res) => {
          res.writeHead(200);
          res.end("ok");
        });
        const port = await new Promise<number>((resolve) => {
          server.listen(0, "127.0.0.1", () => {
            const addr = server.address();
            resolve(typeof addr === "object" && addr ? addr.port : 0);
          });
        });

        try {
          const mp = new ManagedProcess(
            makeRunningSpec({
              id: "http-pass",
              health: {
                kind: "http",
                url: `http://127.0.0.1:${port}/`,
                expectedStatus: 200,
                retries: 3,
                intervalMs: 100,
              },
            }),
          );

          await mp.start();
          assert.equal(
            mp.state,
            "running",
            "should transition to running when HTTP probe succeeds",
          );
          await mp.stop();
        } finally {
          server.close();
        }
      });

      it("fails when HTTP server returns wrong status code", async () => {
        const server = http.createServer((_req, res) => {
          res.writeHead(503);
          res.end("service unavailable");
        });
        const port = await new Promise<number>((resolve) => {
          server.listen(0, "127.0.0.1", () => {
            const addr = server.address();
            resolve(typeof addr === "object" && addr ? addr.port : 0);
          });
        });

        try {
          const mp = new ManagedProcess(
            makeRunningSpec({
              id: "http-wrong-status",
              health: {
                kind: "http",
                url: `http://127.0.0.1:${port}/`,
                expectedStatus: 200,
                retries: 2,
                intervalMs: 50,
              },
            }),
          );

          await assert.rejects(() => mp.start(), /health check failed for http-wrong-status/);

          assert.equal(mp.state, "failed");
        } finally {
          server.close();
        }
      });

      it("fails when HTTP server is not reachable", async () => {
        const mp = new ManagedProcess(
          makeRunningSpec({
            id: "http-unreachable",
            health: {
              kind: "http",
              url: "http://127.0.0.1:59998/",
              retries: 2,
              intervalMs: 50,
              timeoutMs: 200,
            },
          }),
        );

        await assert.rejects(() => mp.start(), /health check failed for http-unreachable/);

        assert.equal(mp.state, "failed");
      });

      it("follows redirects and succeeds when final endpoint returns expected status", async () => {
        const finalServer = http.createServer((_req, res) => {
          res.writeHead(200);
          res.end("ok");
        });
        const finalPort = await new Promise<number>((resolve) => {
          finalServer.listen(0, "127.0.0.1", () => {
            const addr = finalServer.address();
            resolve(typeof addr === "object" && addr ? addr.port : 0);
          });
        });

        const redirectServer = http.createServer((_req, res) => {
          res.writeHead(302, { Location: `http://127.0.0.1:${finalPort}/` });
          res.end();
        });
        const redirectPort = await new Promise<number>((resolve) => {
          redirectServer.listen(0, "127.0.0.1", () => {
            const addr = redirectServer.address();
            resolve(typeof addr === "object" && addr ? addr.port : 0);
          });
        });

        try {
          const mp = new ManagedProcess(
            makeRunningSpec({
              id: "http-redirect",
              health: {
                kind: "http",
                url: `http://127.0.0.1:${redirectPort}/`,
                expectedStatus: 200,
                retries: 3,
                intervalMs: 100,
              },
            }),
          );

          await mp.start();
          assert.equal(
            mp.state,
            "running",
            "should follow redirect and succeed when final endpoint returns 200",
          );
          await mp.stop();
        } finally {
          redirectServer.close();
          finalServer.close();
        }
      });
    });

    describe("_probeExec", () => {
      it("succeeds when command exits cleanly", async () => {
        const mp = new ManagedProcess(
          makeRunningSpec({
            id: "exec-pass",
            health: {
              kind: "exec",
              command: "echo",
              args: ["healthy"],
              retries: 3,
              intervalMs: 100,
            },
          }),
        );

        await mp.start();
        assert.equal(mp.state, "running", "should transition to running when exec probe succeeds");
        await mp.stop();
      });

      it("fails and retries when command exits non-zero", async () => {
        const mp = new ManagedProcess(
          makeRunningSpec({
            id: "exec-fail",
            health: {
              kind: "exec",
              command: "sh",
              args: ["-c", "exit 1"],
              retries: 2,
              intervalMs: 50,
            },
          }),
        );

        await assert.rejects(() => mp.start(), /health check failed for exec-fail/);

        assert.equal(mp.state, "failed");
      });
    });
  });

  // ===========================================================================
  // NEW TESTS — restart policy signal behavior
  // ===========================================================================

  describe("restart policy — signal kills", () => {
    it("does not restart on signal kill with on-failure policy", async () => {
      const mp = new ManagedProcess(
        makeRunningSpec({
          id: "signal-no-restart",
          restart: {
            mode: "on-failure",
            maxRetries: 2,
            initialDelayMs: 50,
            backoffMultiplier: 1,
            maxDelayMs: 100,
          },
        }),
      );

      await mp.start();
      assert.equal(mp.state, "running");

      // Kill externally with SIGKILL (simulates OOM kill)
      mp.kill();

      // Wait for process to exit
      await waitForState(mp, "exited", 5000);

      // Should transition to dead without restarting
      await waitForState(mp, "dead", 5000);

      assert.equal(mp.state, "dead");
      assert.equal(mp.restartCount, 0, "should not restart on signal kill");
      assert.equal(mp.lastSignal, "SIGKILL");
    });

    it("restarts on signal kill with on-unexpected-exit policy", async () => {
      const mp = new ManagedProcess(
        makeRunningSpec({
          id: "signal-unexpected-restart",
          restart: {
            mode: "on-unexpected-exit",
            maxRetries: 2,
            initialDelayMs: 50,
            backoffMultiplier: 1,
            maxDelayMs: 100,
          },
        }),
      );

      await mp.start();
      assert.equal(mp.state, "running");

      // Kill externally with SIGKILL
      mp.kill();

      // Wait for the process to be restarted (restartCount increments)
      await new Promise<void>((resolve) => {
        const check = () => {
          if (mp.restartCount >= 1) return resolve();
          mp.once("state-change", check);
        };
        check();
      });

      assert.ok(
        mp.restartCount >= 1,
        `should have restarted after signal kill, got ${mp.restartCount}`,
      );

      // The restarted process is now running (sleep 60). Stop it cleanly.
      await mp.stop();
      assert.equal(mp.state, "dead");
    });

    it("restarts on non-zero exit code with on-failure policy", async () => {
      const mp = new ManagedProcess(
        makeSpec({
          id: "exit-code-restart",
          command: "sh",
          args: ["-c", "exit 1"],
          restart: {
            mode: "on-failure",
            maxRetries: 1,
            initialDelayMs: 50,
            backoffMultiplier: 1,
            maxDelayMs: 100,
          },
        }),
      );

      await mp.start();

      // Wait for it to exhaust retries and go dead
      await waitForState(mp, "dead", 10000);

      assert.equal(mp.state, "dead");
      assert.ok(
        mp.restartCount >= 1,
        `should have restarted on non-zero exit, got ${mp.restartCount}`,
      );
    });

    it("restarts on non-zero exit code with on-unexpected-exit policy", async () => {
      const mp = new ManagedProcess(
        makeSpec({
          id: "exit-code-unexpected",
          command: "sh",
          args: ["-c", "exit 1"],
          restart: {
            mode: "on-unexpected-exit",
            maxRetries: 1,
            initialDelayMs: 50,
            backoffMultiplier: 1,
            maxDelayMs: 100,
          },
        }),
      );

      await mp.start();

      // Wait for it to exhaust retries and go dead
      await waitForState(mp, "dead", 10000);

      assert.equal(mp.state, "dead");
      assert.ok(
        mp.restartCount >= 1,
        `should have restarted on non-zero exit, got ${mp.restartCount}`,
      );
    });
  });

  // ===========================================================================
  // NEW TESTS — preStop hook execution
  // ===========================================================================

  describe("preStop hook", () => {
    it("runs preStop command before stopping the process", async () => {
      const tmpFile = path.join(os.tmpdir(), `procman-prestop-${Date.now()}.txt`);
      cleanupTmpFiles.push(tmpFile);

      const mp = new ManagedProcess(
        makeRunningSpec({
          id: "prestop-test",
          shutdown: {
            signal: "SIGTERM",
            graceMs: 2000,
            preStop: {
              command: "touch",
              args: [tmpFile],
            },
          },
        }),
      );

      await mp.start();
      assert.equal(mp.state, "running");

      await mp.stop();
      assert.equal(mp.state, "dead");

      // Verify the preStop command ran
      assert.ok(fs.existsSync(tmpFile), `preStop should have created ${tmpFile}`);
    });

    it("still stops the process even when preStop command fails", async () => {
      const mp = new ManagedProcess(
        makeRunningSpec({
          id: "prestop-fail-test",
          shutdown: {
            signal: "SIGTERM",
            graceMs: 2000,
            preStop: {
              command: "false", // exits with code 1
            },
          },
        }),
      );

      await mp.start();
      assert.equal(mp.state, "running");

      await mp.stop();
      assert.equal(mp.state, "dead");
    });
  });

  // ===========================================================================
  // NEW TESTS — maxRuntimeSeconds resource limit
  // ===========================================================================

  describe("maxRuntimeSeconds", () => {
    it("stops the process when runtime limit is exceeded", async () => {
      const mp = new ManagedProcess(
        makeRunningSpec({
          id: "runtime-limit",
          limits: {
            maxRuntimeSeconds: 1,
          },
        }),
      );

      await mp.start();
      assert.equal(mp.state, "running");

      // Wait for the runtime limit to trigger stop
      await waitForState(mp, "dead", 10000);

      assert.equal(mp.state, "dead");
    }, 15000);

    it("emits state-change through stopping when runtime limit fires", async () => {
      const states: string[] = [];
      const mp = new ManagedProcess(
        makeRunningSpec({
          id: "runtime-limit-events",
          limits: {
            maxRuntimeSeconds: 1,
          },
        }),
      );

      mp.on("state-change", (s: string) => states.push(s));

      await mp.start();
      assert.equal(mp.state, "running");

      await waitForState(mp, "dead", 10000);

      assert.ok(states.includes("stopping"), "should have passed through stopping state");
      assert.ok(states.includes("dead"), "should have reached dead state");
    }, 15000);
  });

  // ===========================================================================
  // NEW TESTS — Safety timeout path in stop()
  // ===========================================================================

  describe("stop() safety timeout", () => {
    it("stop resolves even for a process that was already stopped", async () => {
      const mp = new ManagedProcess(
        makeRunningSpec({
          id: "already-stopped",
        }),
      );

      await mp.start();
      assert.equal(mp.state, "running");

      // Kill it first
      mp.kill();
      await waitForState(mp, "dead", 5000);
      assert.equal(mp.state, "dead");

      // Calling stop on a dead process should be a no-op and resolve immediately
      await mp.stop();
      assert.equal(mp.state, "dead");
    });

    it("stop resolves immediately when process is already dead (no child)", async () => {
      const mp = new ManagedProcess(makeSpec({ id: "short-lived" }));

      // The process is a short-lived echo — wait for it to finish naturally
      await mp.start();
      await waitForState(mp, "dead", 5000);

      assert.equal(mp.state, "dead");

      // stop on dead process should resolve without error
      await mp.stop();
      assert.equal(mp.state, "dead");
    });
  });

  // ===========================================================================
  // NEW TESTS — zombie process cleanup (issue #213)
  // ===========================================================================

  describe("zombie process cleanup", () => {
    it("cleans up child reference when process exits naturally without restart", async () => {
      const mp = new ManagedProcess(makeSpec({ id: "zombie-test" }));

      await mp.start();
      // echo exits immediately — wait for it to finish naturally
      await waitForState(mp, "dead", 5000);

      assert.equal(mp.state, "dead");
      // _finalize() should have nulled the pid, confirming child cleanup
      assert.equal(mp.pid, undefined, "pid should be undefined after natural exit without restart");
    });

    it("cleans up child reference when process exits with non-zero code and never policy", async () => {
      const mp = new ManagedProcess(
        makeSpec({
          id: "zombie-exit1",
          command: "sh",
          args: ["-c", "exit 1"],
          restart: { mode: "never" },
        }),
      );

      await mp.start();
      await waitForState(mp, "dead", 5000);

      assert.equal(mp.state, "dead");
      assert.equal(
        mp.pid,
        undefined,
        "pid should be undefined after non-zero exit with never policy",
      );
    });

    it("cleans up child reference when on-failure process exhausts retries", async () => {
      const mp = new ManagedProcess(
        makeSpec({
          id: "zombie-exhaust",
          command: "sh",
          args: ["-c", "exit 1"],
          restart: {
            mode: "on-failure",
            maxRetries: 1,
            initialDelayMs: 50,
            backoffMultiplier: 1,
            maxDelayMs: 100,
          },
        }),
      );

      await mp.start();
      await waitForState(mp, "dead", 10000);

      assert.equal(mp.state, "dead");
      assert.equal(mp.pid, undefined, "pid should be undefined after exhausting retries");
    });
  });
});
