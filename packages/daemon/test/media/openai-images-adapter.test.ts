import { describe, it, vi, beforeEach, expect } from "vitest";
import { openAIImagesAdapter } from "../../src/media/adapters/openai-images-adapter";
import type { MediaAdapterResult } from "../../src/media/adapters/types";
import type { ResolvedMediaProvider } from "../../src/media/resolve-model";

// DI: inject fakes via MediaAdapterDeps instead of mocking node:fs/promises or
// stubbing global fetch (both are import-order dependent under --no-isolate).
const mockFetch = vi.fn();
const mockWriteFile = vi.fn().mockResolvedValue(undefined);
const mockMkdir = vi.fn().mockResolvedValue(undefined);

function makeDeps() {
  return { fetchFn: mockFetch, writeFile: mockWriteFile, mkdir: mockMkdir };
}

function makeProvider(overrides?: Partial<ResolvedMediaProvider>): ResolvedMediaProvider {
  return {
    id: "openai",
    kind: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "test-api-key",
    ...overrides,
  };
}

function makeRequest(overrides?: Partial<Parameters<typeof openAIImagesAdapter>[0]>) {
  return {
    model: "dall-e-3",
    prompt: "a cat wearing a hat",
    provider: makeProvider(),
    outputPath: "/tmp/media/output.png",
    params: { kind: "image" },
    ...overrides,
  };
}

function makeB64JsonResponse(base64Image: string) {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({
      data: [
        {
          b64_json: base64Image,
          revised_prompt: "a cat wearing a hat",
        },
      ],
    }),
  };
}

function makeUrlResponse(imageUrl: string) {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({
      data: [
        {
          url: imageUrl,
          revised_prompt: "a cat wearing a hat",
        },
      ],
    }),
  };
}

describe("openAIImagesAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("successful generation with b64_json response — decodes and writes file", async () => {
    const rawBytes = "hello-image-data";
    const base64 = Buffer.from(rawBytes).toString("base64");
    mockFetch.mockResolvedValue(makeB64JsonResponse(base64));

    const result = await openAIImagesAdapter(
      makeRequest({ outputPath: "/tmp/media/result.png" }),
      makeDeps(),
    );

    expect(mockMkdir.mock.calls.length).toBe(1);
    expect(mockWriteFile.mock.calls.length).toBe(1);

    const [writePath, writeData] = mockWriteFile.mock.calls[0];
    expect(writePath).toBe("/tmp/media/result.png");
    expect(Buffer.isBuffer(writeData)).toBe(true);
    expect(writeData.toString()).toBe(rawBytes);

    expect(result.status).toBe("complete");
    const complete = result as MediaAdapterResult & { status: "complete" };
    expect(complete.mime_type).toBe("image/png");
    expect(complete.path).toBe("/tmp/media/result.png");
  });

  it("successful generation with url response — downloads and writes file", async () => {
    const imageData = "downloaded-image-bytes";

    // Mock the image download fetch
    mockFetch
      .mockResolvedValueOnce(makeUrlResponse("https://example.com/image.png"))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: vi.fn().mockResolvedValue(Buffer.from(imageData)),
      });

    const result = await openAIImagesAdapter(
      makeRequest({ outputPath: "/tmp/media/result.png" }),
      makeDeps(),
    );

    // Should have made two fetch calls: one for generation, one for download
    expect(mockFetch.mock.calls.length).toBe(2);

    // Second call should be the image download
    const [, downloadOpts] = mockFetch.mock.calls[1];
    expect(downloadOpts.method).toBe("GET");

    expect(mockMkdir.mock.calls.length).toBe(1);
    expect(mockWriteFile.mock.calls.length).toBe(1);

    const [writePath] = mockWriteFile.mock.calls[0];
    expect(writePath).toBe("/tmp/media/result.png");

    expect(result.status).toBe("complete");
    const complete = result as MediaAdapterResult & { status: "complete" };
    expect(complete.mime_type).toBe("image/png");
    expect(complete.path).toBe("/tmp/media/result.png");
  });

  it("aspect ratio mapping: 1:1 -> 1024x1024", async () => {
    const base64 = Buffer.from("test").toString("base64");
    mockFetch.mockResolvedValue(makeB64JsonResponse(base64));

    await openAIImagesAdapter(
      makeRequest({ params: { kind: "image", aspectRatio: "1:1" } }),
      makeDeps(),
    );

    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body as string);
    expect(body.size).toBe("1024x1024");
  });

  it("aspect ratio mapping: 16:9 -> 1792x1024", async () => {
    const base64 = Buffer.from("test").toString("base64");
    mockFetch.mockResolvedValue(makeB64JsonResponse(base64));

    await openAIImagesAdapter(
      makeRequest({ params: { kind: "image", aspectRatio: "16:9" } }),
      makeDeps(),
    );

    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body as string);
    expect(body.size).toBe("1792x1024");
  });

  it("aspect ratio mapping: 9:16 -> 1024x1792", async () => {
    const base64 = Buffer.from("test").toString("base64");
    mockFetch.mockResolvedValue(makeB64JsonResponse(base64));

    await openAIImagesAdapter(
      makeRequest({ params: { kind: "image", aspectRatio: "9:16" } }),
      makeDeps(),
    );

    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body as string);
    expect(body.size).toBe("1024x1792");
  });

  it("aspect ratio mapping: 4:3 -> 1536x1024", async () => {
    const base64 = Buffer.from("test").toString("base64");
    mockFetch.mockResolvedValue(makeB64JsonResponse(base64));

    await openAIImagesAdapter(
      makeRequest({ params: { kind: "image", aspectRatio: "4:3" } }),
      makeDeps(),
    );

    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body as string);
    expect(body.size).toBe("1536x1024");
  });

  it("aspect ratio mapping: 3:4 -> 1024x1536", async () => {
    const base64 = Buffer.from("test").toString("base64");
    mockFetch.mockResolvedValue(makeB64JsonResponse(base64));

    await openAIImagesAdapter(
      makeRequest({ params: { kind: "image", aspectRatio: "3:4" } }),
      makeDeps(),
    );

    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body as string);
    expect(body.size).toBe("1024x1536");
  });
  it("no aspectRatio or size defaults to 1024x1024", async () => {
    const base64 = Buffer.from("test").toString("base64");
    mockFetch.mockResolvedValue(makeB64JsonResponse(base64));

    await openAIImagesAdapter(makeRequest({ params: { kind: "image" } }), makeDeps());

    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body as string);
    expect(body.size).toBe("1024x1024");
  });

  it("raw size string is used when no aspectRatio is provided", async () => {
    const base64 = Buffer.from("test").toString("base64");
    mockFetch.mockResolvedValue(makeB64JsonResponse(base64));

    await openAIImagesAdapter(
      makeRequest({ params: { kind: "image", size: "512x512" } }),
      makeDeps(),
    );

    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body as string);
    expect(body.size).toBe("512x512");
  });

  it("aspectRatio takes precedence over size when both provided", async () => {
    const base64 = Buffer.from("test").toString("base64");
    mockFetch.mockResolvedValue(makeB64JsonResponse(base64));

    await openAIImagesAdapter(
      makeRequest({ params: { kind: "image", aspectRatio: "16:9", size: "512x512" } }),
      makeDeps(),
    );

    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body as string);
    expect(body.size).toBe("1792x1024");
  });

  it("unsupported aspectRatio returns error", async () => {
    const result = await openAIImagesAdapter(
      makeRequest({ params: { kind: "image", aspectRatio: "3:2" } }),
      makeDeps(),
    );

    expect(result.status).toBe("error");
    const error = result as MediaAdapterResult & { status: "error" };
    expect(error.error).toContain("Unsupported aspectRatio");
    expect(error.error).toContain("3:2");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("error response (non-200) returns error status", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      text: vi.fn().mockResolvedValue('{"error":{"message":"Invalid request"}}'),
    });

    const result = await openAIImagesAdapter(makeRequest(), makeDeps());

    expect(result.status).toBe("error");
    const error = result as MediaAdapterResult & { status: "error" };
    expect(error.error.length).toBeGreaterThan(0);
    expect(error.error).toContain("400");
  });

  it("sends correct auth header: Authorization: Bearer {apiKey}", async () => {
    const base64 = Buffer.from("test").toString("base64");
    mockFetch.mockResolvedValue(makeB64JsonResponse(base64));

    await openAIImagesAdapter(
      makeRequest({ provider: makeProvider({ apiKey: "my-secret-key" }) }),
      makeDeps(),
    );

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers).toHaveProperty("Authorization", "Bearer my-secret-key");
  });

  it("sends correct request body: { model, prompt, n:1, size, response_format:'b64_json' }", async () => {
    const base64 = Buffer.from("test").toString("base64");
    mockFetch.mockResolvedValue(makeB64JsonResponse(base64));

    await openAIImagesAdapter(
      makeRequest({
        model: "dall-e-4",
        params: { kind: "image", aspectRatio: "16:9" },
      }),
      makeDeps(),
    );

    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body as string);

    expect(body.model).toBe("dall-e-4");
    expect(body.prompt).toBe("a cat wearing a hat");
    expect(body.n).toBe(1);
    expect(body.size).toBe("1792x1024");
    expect(body.response_format).toBe("b64_json");
  });

  it("POSTs to {baseUrl}/images/generations", async () => {
    const base64 = Buffer.from("test").toString("base64");
    mockFetch.mockResolvedValue(makeB64JsonResponse(base64));

    await openAIImagesAdapter(
      makeRequest({ provider: makeProvider({ baseUrl: "https://custom.api.com/v1" }) }),
      makeDeps(),
    );

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("https://custom.api.com/v1/images/generations");
    expect(url).toContain("/images/generations");
  });
});
