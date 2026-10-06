import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateFetchCaBundle } from "../../src/config/validate-fetch-ca-bundle";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

function withTempFile(name: string, content: string, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "ca-bundle-validate-"));
  try {
    const path = join(dir, name);
    writeFileSync(path, content);
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

describe("validateFetchCaBundle", () => {
  it("accepts a valid PEM certificate bundle", () => {
    const r = validateFetchCaBundle(join(fixturesDir, "localhost-cert.pem"));
    expect(r).toEqual({ ok: true });
  });

  it("reports a missing file without throwing", () => {
    const r = validateFetchCaBundle(join(fixturesDir, "does-not-exist.pem"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/cannot read file/);
  });

  it("reports an empty file without throwing", () => {
    withTempFile("empty.pem", "", (path) => {
      const r = validateFetchCaBundle(path);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/empty/);
    });
  });

  it("reports content that is not a PEM bundle without throwing", () => {
    withTempFile("garbage.pem", "this is not a certificate\n", (path) => {
      const r = validateFetchCaBundle(path);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/not a valid PEM certificate bundle/);
    });
  });

  it("reports a truncated/corrupt PEM without throwing", () => {
    withTempFile("truncated.pem", "-----BEGIN CERTIFICATE-----\nnot base64!!\n", (path) => {
      const r = validateFetchCaBundle(path);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/not a valid PEM certificate bundle/);
    });
  });
});
