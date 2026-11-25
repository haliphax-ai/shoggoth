import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadFileToDisk } from "../src/download-file";

function streamResponse(chunks: Uint8Array[], init?: ResponseInit): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(stream, { status: 200, ...init });
}

describe("downloadFileToDisk", () => {
  let dir: string;
  let prevFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "download-file-"));
    prevFetch = globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = prevFetch;
    await rm(dir, { recursive: true, force: true });
  });

  it("streams the body to disk and returns the byte count", async () => {
    const payload = new TextEncoder().encode("hello world");
    globalThis.fetch = async () => streamResponse([payload]);
    const dest = join(dir, "nested", "out.bin");

    const bytes = await downloadFileToDisk("https://cdn/x.bin", dest, 1024);

    expect(bytes).toBe(payload.byteLength);
    expect(await readFile(dest)).toEqual(Buffer.from(payload));
  });

  it("throws and removes the partial file when the body exceeds the budget", async () => {
    const first = new TextEncoder().encode("aa");
    const second = new TextEncoder().encode("bbbb");
    globalThis.fetch = async () => streamResponse([first, second]);

    await expect(
      downloadFileToDisk("https://cdn/big.bin", join(dir, "big.bin"), 4),
    ).rejects.toThrow(/too large/);

    const leftovers = await readdir(dir);
    expect(leftovers).toEqual([]);
  });

  it("throws on non-2xx responses without writing anything", async () => {
    globalThis.fetch = async () => new Response("nope", { status: 404 });

    await expect(
      downloadFileToDisk("https://cdn/missing.bin", join(dir, "missing.bin"), 1024),
    ).rejects.toThrow(/HTTP 404/);

    const leftovers = await readdir(dir);
    expect(leftovers).toEqual([]);
  });

  it("accepts a body-less response and writes a zero-byte file", async () => {
    globalThis.fetch = async () => new Response(null, { status: 200 });

    const bytes = await downloadFileToDisk("https://cdn/empty.bin", join(dir, "empty.bin"), 1024);

    expect(bytes).toBe(0);
    expect((await readFile(join(dir, "empty.bin"))).byteLength).toBe(0);
  });
});
