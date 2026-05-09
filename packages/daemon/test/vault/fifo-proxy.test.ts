import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createSecretFifo } from "../../src/vault/fifo-proxy";
import { spawnSync } from "node:child_process";
const VAULT_DIR = "/tmp/.vault";

/**
 * Check if mkfifo works in the actual vault directory.
 * Returns true if we can create FIFOs there.
 */
function canCreateFifos(): boolean {
  try {
    mkdirSync(VAULT_DIR, { mode: 0o755, recursive: true });
    const testPath = join(VAULT_DIR, "probe_" + Date.now());
    const r = spawnSync("mkfifo", [testPath]);
    if (r.status === 0) {
      try {
        require("node:fs").unlinkSync(testPath);
      } catch {
        /* ignore */
      }
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

const FIFO_AVAILABLE = canCreateFifos();
describe.skipIf(!FIFO_AVAILABLE)("createSecretFifo", () => {
  afterEach(async () => {
    // Cleanup any leftover FIFOs in /tmp/.vault
    try {
      const { readdirSync, unlinkSync, statSync } = await import("node:fs");
      if (!existsSync(VAULT_DIR)) return;
      const files = readdirSync(VAULT_DIR);
      for (const file of files) {
        const path = join(VAULT_DIR, file);
        try {
          const stat = statSync(path);
          if (stat.isFIFO()) unlinkSync(path);
        } catch {
          /* ignore */
        }
      }
    } catch {
      // Directory might not exist, that's ok
    }
  });

  it("creates FIFO at expected path pattern under /tmp/.vault/", async () => {
    const secret = "test-secret";
    const path = await createSecretFifo(secret, 1000, 1000);

    expect(path).toMatch(/^\/tmp\/\.vault\/[a-f0-9]+$/);
    expect(existsSync(path)).toBe(true);
  });

  it("reading from FIFO returns the secret", async () => {
    const secret = "my-secret-value-123";
    const path = await createSecretFifo(secret, 1000, 1000);

    // Open FIFO for reading
    const readPromise = new Promise<string>((resolve, reject) => {
      const stream = require("node:fs").createReadStream(path, { encoding: "utf8" });
      let data = "";
      stream.on("data", (chunk: string) => {
        data += chunk;
      });
      stream.on("end", () => {
        resolve(data);
      });
      stream.on("error", reject);
    });

    const result = await readPromise;
    expect(result).toBe(secret);
  });

  it("FIFO is unlinked after read", async () => {
    const secret = "temp-secret";
    const path = await createSecretFifo(secret, 1000, 1000);

    // Read from the FIFO to trigger the unlink
    const readPromise = new Promise<string>((resolve, reject) => {
      const stream = require("node:fs").createReadStream(path, { encoding: "utf8" });
      let data = "";
      stream.on("data", (chunk: string) => {
        data += chunk;
      });
      stream.on("end", () => {
        resolve(data);
      });
      stream.on("error", reject);
    });

    await readPromise;

    // Give a small delay for cleanup to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(existsSync(path)).toBe(false);
  });

  it("timeout cleanup removes FIFO if not read", async () => {
    const secret = "timeout-test-secret";
    const timeoutMs = 500; // Short timeout for test
    const path = await createSecretFifo(secret, 1000, 1000, timeoutMs);

    expect(existsSync(path)).toBe(true);

    // Wait for timeout to expire
    await new Promise((resolve) => setTimeout(resolve, timeoutMs + 200));

    expect(existsSync(path)).toBe(false);
  });

  it("sets permissions to 0644", async () => {
    const secret = "permission-test";
    const path = await createSecretFifo(secret, 1000, 1000);

    expect(existsSync(path)).toBe(true);
    const { statSync } = require("node:fs");
    const stat = statSync(path);
    // 0644 = 0o100644 & 0o777 = 0o644 = 420
    expect(stat.mode & 0o777).toBe(0o644);
  });
});
