import { describe, it, vi, beforeEach } from "vitest";
import assert from "node:assert";

// Mock node:fs/promises for file writing
vi.mock("node:fs/promises", () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue(Buffer.from("fake-image-bytes")),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { predictAdapter } from "../../src/media/adapters/predict-adapter";
import type { MediaAdapterRequest, MediaAdapterResult } from "../../src/media/adapters/types";

function makeRequest(overrides?: Partial<MediaAdapterRequest>): MediaAdapterRequest {
  return {
    model: "imagen-4.0-generate-preview-06-2025",
    prompt: "a cat wearing a hat",
    apiKey: "test-api-key",
    baseUrl: "https://generativelanguage.googleapis.com",
    outputPath: "/tmp/media/output.png",
    params: { kind: "image" },
    ...overrides,
  };
}

function makePredictResponse(base64Images: string[]) {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({
      predictions: base64Images.map((b64) => ({
        bytesBase64Encoded: b64,
      })),
    }),
  };
}

describe("predictAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends correct POST to {baseUrl}/v1beta/models/{model}:predict with API key", async () => {
    const base64 = Buffer.from("fake-png-bytes").toString("base64");
    mockFetch.mockResolvedValue(makePredictResponse([base64]));

    await predictAdapter(makeRequest());

    assert.strictEqual(mockFetch.mock.calls.length, 1);
    const [url, opts] = mockFetch.mock.calls[0];
    assert.ok(
      url.includes("/v1beta/models/imagen-4.0-generate-preview-06-2025:predict"),
      `URL should contain predict endpoint, got: ${url}`,
    );
    assert.ok(url.includes("key=test-api-key"), `URL should contain API key, got: ${url}`);
    assert.strictEqual(opts.method, "POST");
    assert.strictEqual(opts.headers["Content-Type"], "application/json");
  });

  it("request body has instances with prompt and parameters with sampleCount and aspectRatio", async () => {
    const base64 = Buffer.from("fake-png-bytes").toString("base64");
    mockFetch.mockResolvedValue(makePredictResponse([base64]));

    await predictAdapter(
      makeRequest({
        params: { kind: "image", aspectRatio: "16:9", numberOfImages: 3 },
      }),
    );

    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);

    assert.deepStrictEqual(body.instances, [{ prompt: "a cat wearing a hat" }]);
    assert.strictEqual(body.parameters.sampleCount, 3);
    assert.strictEqual(body.parameters.aspectRatio, "16:9");
  });

  it("parses predictions[].bytesBase64Encoded from response, decodes, writes file", async () => {
    const rawBytes = "hello-image-data";
    const base64 = Buffer.from(rawBytes).toString("base64");
    mockFetch.mockResolvedValue(makePredictResponse([base64]));

    await predictAdapter(makeRequest({ outputPath: "/tmp/media/result.png" }));

    assert.strictEqual(vi.mocked(mkdir).mock.calls.length, 1);
    assert.strictEqual(vi.mocked(writeFile).mock.calls.length, 1);

    const [writePath, writeData] = vi.mocked(writeFile).mock.calls[0];
    assert.strictEqual(writePath, "/tmp/media/result.png");
    assert.ok(Buffer.isBuffer(writeData));
    assert.strictEqual(writeData.toString(), rawBytes);
  });

  it("returns correct path and mime_type (image/png) in result", async () => {
    const base64 = Buffer.from("png-data").toString("base64");
    mockFetch.mockResolvedValue(makePredictResponse([base64]));

    const result = await predictAdapter(makeRequest({ outputPath: "/tmp/media/out.png" }));

    assert.strictEqual(result.status, "complete");
    const complete = result as MediaAdapterResult & { status: "complete" };
    assert.strictEqual(complete.mime_type, "image/png");
    assert.strictEqual(complete.path, "/tmp/media/out.png");
  });

  it("handles multiple images when numberOfImages > 1 (writes multiple files)", async () => {
    const img1 = Buffer.from("image-one").toString("base64");
    const img2 = Buffer.from("image-two").toString("base64");
    const img3 = Buffer.from("image-three").toString("base64");
    mockFetch.mockResolvedValue(makePredictResponse([img1, img2, img3]));

    const result = await predictAdapter(
      makeRequest({
        outputPath: "/tmp/media/batch.png",
        params: { kind: "image", numberOfImages: 3 },
      }),
    );

    // Should write 3 files (e.g. batch.png, batch_1.png, batch_2.png or similar naming)
    assert.strictEqual(vi.mocked(writeFile).mock.calls.length, 3);

    // First file should use the original output path
    const [firstPath] = vi.mocked(writeFile).mock.calls[0];
    assert.strictEqual(firstPath, "/tmp/media/batch.png");

    // Result should still be complete
    assert.strictEqual(result.status, "complete");
  });

  it("includes input image as instances[].image.bytesBase64Encoded when input_image is provided", async () => {
    const base64 = Buffer.from("edited-image").toString("base64");
    mockFetch.mockResolvedValue(makePredictResponse([base64]));

    await predictAdapter(
      makeRequest({
        params: { kind: "image", input_image: "/workspace/input.png" },
      }),
    );

    // readFile should have been called to read the input image
    assert.ok(vi.mocked(readFile).mock.calls.length > 0);
    const readPath = vi.mocked(readFile).mock.calls[0][0];
    assert.strictEqual(readPath, "/workspace/input.png");

    // The request body should include the image in instances
    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    const instance = body.instances[0];
    assert.ok(
      instance.image?.bytesBase64Encoded,
      "instance should include image.bytesBase64Encoded for input image",
    );
    assert.ok(instance.image.bytesBase64Encoded.length > 0);
  });

  it("handles API error responses gracefully", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      text: vi.fn().mockResolvedValue('{"error":{"message":"Rate limit exceeded"}}'),
    });

    const result = await predictAdapter(makeRequest());

    assert.strictEqual(result.status, "error");
    const error = result as MediaAdapterResult & { status: "error" };
    assert.ok(error.error.length > 0);
    assert.ok(error.error.includes("429"), `Error should mention status code, got: ${error.error}`);
  });

  it("uses correct default parameters when optional params are omitted", async () => {
    const base64 = Buffer.from("default-image").toString("base64");
    mockFetch.mockResolvedValue(makePredictResponse([base64]));

    // Minimal params — only kind: "image", no aspectRatio or numberOfImages
    await predictAdapter(makeRequest({ params: { kind: "image" } }));

    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);

    // Should default sampleCount to 1
    assert.strictEqual(body.parameters.sampleCount, 1);
    // Should default aspectRatio to "1:1"
    assert.strictEqual(body.parameters.aspectRatio, "1:1");
  });
});
