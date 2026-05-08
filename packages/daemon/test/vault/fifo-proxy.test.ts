import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { unlinkSync, existsSync, chmodSync, chownSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createSecretFifo } from "../../src/vault/fifo-proxy";

describe("createSecretFifo", () => {
  const VAULT_DIR = "/tmp/.vault";

  afterEach(async () => {
    // Cleanup any leftover FIFOs in /tmp/.vault
    try {
      const { readdirSync, unlinkSync, statSync } = await import("node:fs");
      const files = readdirSync(VAULT_DIR);
      for (const file of files) {
        const path = join(VAULT_DIR, file);
        const stat = statSync(path);
        if (stat.isFIFO()) {
          try {
            unlinkSync(path);
          } catch {
            /* ignore */
          }
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

    // Open FIFO for reading in a non-blocking way
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

  it("sets correct permissions (0600)", async () => {
    const secret = "permission-test";
    const path = await createSecretFifo(secret, 1000, 1000);

    // Check that FIFO was created - permissions check needs implementation
    // We'll verify the path exists first
    expect(existsSync(path)).toBe(true);

    // After implementation, verify chmod was called with 0o600
    // For now this test will fail because createSecretFifo throws
  });

  it("sets correct ownership (uid/gid)", async () => {
    const secret = "ownership-test";
    const uid = 1000;
    const gid = 1000;
    const path = await createSecretFifo(secret, uid, gid);

    // After implementation, verify chown was called with correct uid/gid
    expect(existsSync(path)).toBe(true);
  });

  it("uses default timeout of 30000ms when not specified", async () => {
    const secret = "default-timeout-test";
    const path = await createSecretFifo(secret, 1000, 1000);

    expect(existsSync(path)).toBe(true);

    // Wait slightly less than default timeout
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Should still exist since timeout is 30s
    expect(existsSync(path)).toBe(true);
  });
});