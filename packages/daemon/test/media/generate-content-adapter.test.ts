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
import { generateContentAdapter } from "../../src/media/adapters/generate-content-adapter";
import type { MediaAdapterRequest, MediaAdapterResult } from "../../src/media/adapters/types";

function makeRequest(overrides?: Partial<MediaAdapterRequest>): MediaAdapterRequest {
  return {
    model: "nano-banana",
    prompt: "a cat wearing a hat",
    apiKey: "test-api-key",
    baseUrl: "https://generativelanguage.googleapis.com",
    outputPath: "/tmp/media/output.png",
    params: { kind: "image" },
    ...overrides,
  };
}

function makeGenerateContentResponse(mimeType: string, base64Data: string) {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({
      candidates: [
        {
          content: {
            parts: [
              {
                inlineData: {
                  mimeType,
                  data: base64Data,
                },
              },
            ],
          },
        },
      ],
    }),
  };
}

describe("generateContentAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends correct generateContent POST with responseModalities: ['IMAGE'] for image models", async () => {
    const base64 = Buffer.from("fake-png-bytes").toString("base64");
    mockFetch.mockResolvedValue(makeGenerateContentResponse("image/png", base64));

    await generateContentAdapter(makeRequest({ model: "nano-banana" }));

    assert.strictEqual(mockFetch.mock.calls.length, 1);
    const [url, opts] = mockFetch.mock.calls[0];
    assert.ok(url.includes("nano-banana"));
    assert.ok(url.includes("generateContent"));
    assert.strictEqual(opts.method, "POST");

    const body = JSON.parse(opts.body);
    assert.deepStrictEqual(body.generationConfig.responseModalities, ["IMAGE"]);
  });

  it("sends correct request with responseModalities: ['AUDIO'] + speechConfig for TTS models", async () => {
    const base64 = Buffer.from("fake-audio-bytes").toString("base64");
    mockFetch.mockResolvedValue(makeGenerateContentResponse("audio/wav", base64));

    await generateContentAdapter(
      makeRequest({
        model: "gemini-2.5-flash-preview-tts",
        prompt: "Hello world",
        params: { kind: "speech", voice: "Kore" },
      }),
    );

    assert.strictEqual(mockFetch.mock.calls.length, 1);
    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    assert.deepStrictEqual(body.generationConfig.responseModalities, ["AUDIO"]);
    assert.strictEqual(
      body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName,
      "Kore",
    );
  });

  it("sends correct request with responseModalities: ['AUDIO'] for music models (lyria)", async () => {
    const base64 = Buffer.from("fake-music-bytes").toString("base64");
    mockFetch.mockResolvedValue(makeGenerateContentResponse("audio/mpeg", base64));

    await generateContentAdapter(
      makeRequest({
        model: "lyria-3-pro-preview",
        prompt: "upbeat jazz",
        params: { kind: "music" },
      }),
    );

    assert.strictEqual(mockFetch.mock.calls.length, 1);
    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    assert.deepStrictEqual(body.generationConfig.responseModalities, ["AUDIO"]);
    // No speechConfig for music
    assert.strictEqual(body.generationConfig.speechConfig, undefined);
  });

  it("parses inlineData from response candidates, base64-decodes, writes file to output path", async () => {
    const rawBytes = "hello-image-data";
    const base64 = Buffer.from(rawBytes).toString("base64");
    mockFetch.mockResolvedValue(makeGenerateContentResponse("image/png", base64));

    await generateContentAdapter(makeRequest({ outputPath: "/tmp/media/result.png" }));

    assert.strictEqual(vi.mocked(mkdir).mock.calls.length, 1);
    assert.strictEqual(vi.mocked(writeFile).mock.calls.length, 1);

    const [writePath, writeData] = vi.mocked(writeFile).mock.calls[0];
    assert.strictEqual(writePath, "/tmp/media/result.png");
    // Should be a Buffer containing the decoded base64 data
    assert.ok(Buffer.isBuffer(writeData));
    assert.strictEqual(writeData.toString(), rawBytes);
  });

  it("returns correct mime_type and path in result", async () => {
    const base64 = Buffer.from("png-data").toString("base64");
    mockFetch.mockResolvedValue(makeGenerateContentResponse("image/png", base64));

    const result = await generateContentAdapter(makeRequest({ outputPath: "/tmp/media/out.png" }));

    assert.strictEqual(result.status, "complete");
    assert.strictEqual(
      (result as MediaAdapterResult & { status: "complete" }).mime_type,
      "image/png",
    );
    assert.strictEqual(
      (result as MediaAdapterResult & { status: "complete" }).path,
      "/tmp/media/out.png",
    );
  });

  it("handles API error responses gracefully", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      text: vi.fn().mockResolvedValue('{"error":{"message":"Rate limit exceeded"}}'),
    });

    const result = await generateContentAdapter(makeRequest());

    assert.strictEqual(result.status, "error");
    assert.ok((result as MediaAdapterResult & { status: "error" }).error.length > 0);
  });

  it("includes input_image as inlineData part when provided for image editing", async () => {
    const base64 = Buffer.from("edited-image").toString("base64");
    mockFetch.mockResolvedValue(makeGenerateContentResponse("image/png", base64));

    await generateContentAdapter(
      makeRequest({
        params: { kind: "image", input_image: "/workspace/input.png" },
      }),
    );

    // readFile should have been called to read the input image
    assert.ok(vi.mocked(readFile).mock.calls.length > 0);
    const readPath = vi.mocked(readFile).mock.calls[0][0];
    assert.strictEqual(readPath, "/workspace/input.png");

    // The request body should include the image as an inlineData part
    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    const parts = body.contents[0].parts;
    const imagePart = parts.find((p: { inlineData?: { mimeType: string } }) => p.inlineData);
    assert.ok(imagePart, "request should include an inlineData part for the input image");
    assert.ok(imagePart.inlineData.data.length > 0);
  });
});
