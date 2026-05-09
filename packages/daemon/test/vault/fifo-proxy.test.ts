import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSecretFifo } from "../../src/vault/fifo-proxy";

describe("createSecretFifo", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "vault-fifo-test-"));
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("creates FIFO at expected path pattern", async () => {
    const secret = "test-secret";
    const path = await createSecretFifo(secret, 1000, 1000, undefined, testDir);

    expect(path).toMatch(new RegExp(`^${testDir}/[a-f0-9]+$`));
    expect(existsSync(path)).toBe(true);
  });

  it("reading from FIFO returns the secret", async () => {
    const secret = "my-secret-value-123";
    const path = await createSecretFifo(secret, 1000, 1000, undefined, testDir);

    const { createReadStream } = await import("node:fs");
    const result = await new Promise<string>((resolve, reject) => {
      const stream = createReadStream(path, { encoding: "utf8" });
      let data = "";
      stream.on("data", (chunk: string) => {
        data += chunk;
      });
      stream.on("end", () => resolve(data));
      stream.on("error", reject);
    });

    expect(result).toBe(secret);
  });

  it("FIFO is unlinked after read", async () => {
    const secret = "temp-secret";
    const path = await createSecretFifo(secret, 1000, 1000, undefined, testDir);

    const { createReadStream } = await import("node:fs");
    await new Promise<string>((resolve, reject) => {
      const stream = createReadStream(path, { encoding: "utf8" });
      let data = "";
      stream.on("data", (chunk: string) => {
        data += chunk;
      });
      stream.on("end", () => resolve(data));
      stream.on("error", reject);
    });

    // Give a small delay for cleanup to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(existsSync(path)).toBe(false);
  });

  it("timeout cleanup removes FIFO if not read", async () => {
    const secret = "timeout-test-secret";
    const timeoutMs = 500;
    const path = await createSecretFifo(secret, 1000, 1000, timeoutMs, testDir);

    expect(existsSync(path)).toBe(true);

    // Wait for timeout to expire
    await new Promise((resolve) => setTimeout(resolve, timeoutMs + 200));

    expect(existsSync(path)).toBe(false);
  });

  it("sets permissions to 0644", async () => {
    const secret = "permission-test";
    const path = await createSecretFifo(secret, 1000, 1000, undefined, testDir);

    const { statSync } = await import("node:fs");
    const stat = statSync(path);
    expect(stat.mode & 0o777).toBe(0o644);
  });
});
