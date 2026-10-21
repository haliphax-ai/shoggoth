import { describe, it, vi, beforeEach } from "vitest";
import assert from "node:assert";
import { predictAdapter } from "../../src/media/adapters/predict-adapter";
import type { MediaAdapterRequest, MediaAdapterResult } from "../../src/media/adapters/types";

// DI: inject fakes via MediaAdapterDeps instead of mocking node:fs/promises or
// stubbing global fetch (both are import-order dependent under --no-isolate).
const mockFetch = vi.fn();
const mockWriteFile = vi.fn().mockResolvedValue(undefined);
const mockMkdir = vi.fn().mockResolvedValue(undefined);

function makeDeps() {
  return { fetchFn: mockFetch, writeFile: mockWriteFile, mkdir: mockMkdir };
}

function makeRequest(overrides?: Partial<MediaAdapterRequest>): MediaAdapterRequest {
  return {
    model: "imagen-4.0-fast-generate-001",
    prompt: "a cat wearing a hat",
    provider: {
      id: "gemini-test",
      kind: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "test-api-key",
    },
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

    await predictAdapter(makeRequest(), makeDeps());

    assert.strictEqual(mockFetch.mock.calls.length, 1);
    const [url, opts] = mockFetch.mock.calls[0];
    assert.ok(
      url.includes("/v1beta/models/imagen-4.0-fast-generate-001:predict"),
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
      makeDeps(),
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

    await predictAdapter(makeRequest({ outputPath: "/tmp/media/result.png" }), makeDeps());

    assert.strictEqual(mockMkdir.mock.calls.length, 1);
    assert.strictEqual(mockWriteFile.mock.calls.length, 1);

    const [writePath, writeData] = mockWriteFile.mock.calls[0];
    assert.strictEqual(writePath, "/tmp/media/result.png");
    assert.ok(Buffer.isBuffer(writeData));
    assert.strictEqual(writeData.toString(), rawBytes);
  });

  it("returns correct path and mime_type (image/png) in result", async () => {
    const base64 = Buffer.from("png-data").toString("base64");
    mockFetch.mockResolvedValue(makePredictResponse([base64]));

    const result = await predictAdapter(
      makeRequest({ outputPath: "/tmp/media/out.png" }),
      makeDeps(),
    );

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
      makeDeps(),
    );

    // Should write 3 files (e.g. batch.png, batch_1.png, batch_2.png or similar naming)
    assert.strictEqual(mockWriteFile.mock.calls.length, 3);

    // First file should use the original output path
    const [firstPath] = mockWriteFile.mock.calls[0];
    assert.strictEqual(firstPath, "/tmp/media/batch.png");

    // Result should still be complete
    assert.strictEqual(result.status, "complete");
  });

  it("includes input image as instances[].image.bytesBase64Encoded when input_image is provided", async () => {
    const base64 = Buffer.from("edited-image").toString("base64");
    mockFetch.mockResolvedValue(makePredictResponse([base64]));

    await predictAdapter(
      makeRequest({
        params: { kind: "image", input_image: base64 },
      }),
      makeDeps(),
    );

    // The request body should include the image in instances
    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    const instance = body.instances[0];
    assert.ok(
      instance.image?.bytesBase64Encoded,
      "instance should include image.bytesBase64Encoded for input image",
    );
    assert.strictEqual(instance.image.bytesBase64Encoded, base64);
  });

  it("handles API error responses gracefully", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      text: vi.fn().mockResolvedValue('{"error":{"message":"Rate limit exceeded"}}'),
    });

    const result = await predictAdapter(makeRequest(), makeDeps());

    assert.strictEqual(result.status, "error");
    const error = result as MediaAdapterResult & { status: "error" };
    assert.ok(error.error.length > 0);
    assert.ok(error.error.includes("429"), `Error should mention status code, got: ${error.error}`);
  });

  it("uses correct default parameters when optional params are omitted", async () => {
    const base64 = Buffer.from("default-image").toString("base64");
    mockFetch.mockResolvedValue(makePredictResponse([base64]));

    // Minimal params — only kind: "image", no aspectRatio or numberOfImages
    await predictAdapter(makeRequest({ params: { kind: "image" } }), makeDeps());

    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);

    // Should default sampleCount to 1
    assert.strictEqual(body.parameters.sampleCount, 1);
    // Should default aspectRatio to "1:1"
    assert.strictEqual(body.parameters.aspectRatio, "1:1");
  });
});
