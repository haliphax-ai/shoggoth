import { describe, it, vi, beforeEach } from "vitest";
import assert from "node:assert";
import { generateContentAdapter } from "../../src/media/adapters/generate-content-adapter";
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
    model: "gemini-2.5-flash-image",
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

    await generateContentAdapter(makeRequest({ model: "gemini-2.5-flash-image" }), makeDeps());

    assert.strictEqual(mockFetch.mock.calls.length, 1);
    const [url, opts] = mockFetch.mock.calls[0];
    assert.ok(url.includes("gemini-2.5-flash-image"));
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
      makeDeps(),
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
      makeDeps(),
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

    await generateContentAdapter(makeRequest({ outputPath: "/tmp/media/result.png" }), makeDeps());

    assert.strictEqual(mockMkdir.mock.calls.length, 1);
    assert.strictEqual(mockWriteFile.mock.calls.length, 1);

    const [writePath, writeData] = mockWriteFile.mock.calls[0];
    assert.strictEqual(writePath, "/tmp/media/result.png");
    // Should be a Buffer containing the decoded base64 data
    assert.ok(Buffer.isBuffer(writeData));
    assert.strictEqual(writeData.toString(), rawBytes);
  });

  it("returns correct mime_type and path in result", async () => {
    const base64 = Buffer.from("png-data").toString("base64");
    mockFetch.mockResolvedValue(makeGenerateContentResponse("image/png", base64));

    const result = await generateContentAdapter(
      makeRequest({ outputPath: "/tmp/media/out.png" }),
      makeDeps(),
    );

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

    const result = await generateContentAdapter(makeRequest(), makeDeps());

    assert.strictEqual(result.status, "error");
    assert.ok((result as MediaAdapterResult & { status: "error" }).error.length > 0);
  });

  it("passes aspectRatio through generationConfig for image models", async () => {
    const base64 = Buffer.from("fake-png-bytes").toString("base64");
    mockFetch.mockResolvedValue(makeGenerateContentResponse("image/png", base64));

    await generateContentAdapter(
      makeRequest({
        params: { kind: "image", aspectRatio: "16:9" },
      }),
      makeDeps(),
    );

    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    assert.strictEqual(body.generationConfig.imageConfig.aspectRatio, "16:9");
  });

  it("does not include aspectRatio in generationConfig when not provided", async () => {
    const base64 = Buffer.from("fake-png-bytes").toString("base64");
    mockFetch.mockResolvedValue(makeGenerateContentResponse("image/png", base64));

    await generateContentAdapter(makeRequest(), makeDeps());

    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    assert.strictEqual(body.generationConfig.imageConfig, undefined);
  });

  it("does not include aspectRatio in generationConfig for non-image kinds", async () => {
    const base64 = Buffer.from("fake-audio-bytes").toString("base64");
    mockFetch.mockResolvedValue(makeGenerateContentResponse("audio/wav", base64));

    await generateContentAdapter(
      makeRequest({
        model: "gemini-2.5-flash-preview-tts",
        params: { kind: "speech", voice: "Kore" },
      }),
      makeDeps(),
    );

    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    assert.strictEqual(body.generationConfig.imageConfig, undefined);
  });

  it("includes input_image as inlineData part when provided for image editing", async () => {
    const base64 = Buffer.from("edited-image").toString("base64");
    mockFetch.mockResolvedValue(makeGenerateContentResponse("image/png", base64));

    await generateContentAdapter(
      makeRequest({
        params: { kind: "image", input_image: base64 },
      }),
      makeDeps(),
    );

    // The request body should include the image as an inlineData part
    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    const parts = body.contents[0].parts;
    const imagePart = parts.find((p: { inlineData?: { mimeType: string } }) => p.inlineData);
    assert.ok(imagePart, "request should include an inlineData part for the input image");
    assert.strictEqual(imagePart.inlineData.data, base64);
  });
});
