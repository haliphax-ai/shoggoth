import { describe, it, vi, beforeEach, expect } from "vitest";

// Mock node:fs/promises for file writing
vi.mock("node:fs/promises", () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { writeFile, mkdir } from "node:fs/promises";
import { openAIChatImageAdapter } from "../../src/media/adapters/openai-chat-image-adapter";
import type { MediaAdapterResult } from "../../src/media/adapters/types";
import type { ResolvedMediaProvider } from "../../src/media/resolve-model";

function makeProvider(overrides?: Partial<ResolvedMediaProvider>): ResolvedMediaProvider {
  return {
    id: "openai",
    kind: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "test-api-key",
    ...overrides,
  };
}

function makeRequest(overrides?: Partial<Parameters<typeof openAIChatImageAdapter>[0]>) {
  return {
    model: "gpt-4o",
    prompt: "a cat wearing a hat",
    provider: makeProvider(),
    outputPath: "/tmp/media/output.png",
    params: { kind: "image" },
    ...overrides,
  };
}

function makeImageResponse(imageBase64: string, mimeType: string = "image/png") {
  const dataUri = `data:${mimeType};base64,${imageBase64}`;
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: [
              {
                type: "image_url",
                image_url: {
                  url: dataUri,
                },
              },
            ],
          },
        },
      ],
    }),
  };
}

describe("openAIChatImageAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("successful generation — extracts image from choices[0].message.content array, finds part with type:'image_url', decodes data URI base64, writes to file", async () => {
    const rawBytes = "hello-image-data";
    const base64 = Buffer.from(rawBytes).toString("base64");
    mockFetch.mockResolvedValue(makeImageResponse(base64));

    const result = await openAIChatImageAdapter(
      makeRequest({ outputPath: "/tmp/media/result.png" }),
    );

    expect(vi.mocked(mkdir).mock.calls.length).toBe(1);
    expect(vi.mocked(writeFile).mock.calls.length).toBe(1);

    const [writePath, writeData] = vi.mocked(writeFile).mock.calls[0];
    expect(writePath).toBe("/tmp/media/result.png");
    expect(Buffer.isBuffer(writeData)).toBe(true);
    expect(writeData.toString()).toBe(rawBytes);

    expect(result.status).toBe("complete");
    const complete = result as MediaAdapterResult & { status: "complete" };
    expect(complete.path).toBe("/tmp/media/result.png");
  });

  it("extracts correct mime type from data URI (e.g. data:image/png;base64,... -> image/png)", async () => {
    const rawBytes = "hello-image-data";
    const base64 = Buffer.from(rawBytes).toString("base64");
    mockFetch.mockResolvedValue(makeImageResponse(base64, "image/png"));

    const result = await openAIChatImageAdapter(
      makeRequest({ outputPath: "/tmp/media/result.png" }),
    );

    expect(result.status).toBe("complete");
    const complete = result as MediaAdapterResult & { status: "complete" };
    expect(complete.mime_type).toBe("image/png");
  });

  it("extracts correct mime type for jpeg", async () => {
    const rawBytes = "hello-jpeg-data";
    const base64 = Buffer.from(rawBytes).toString("base64");
    mockFetch.mockResolvedValue(makeImageResponse(base64, "image/jpeg"));

    const result = await openAIChatImageAdapter(
      makeRequest({ outputPath: "/tmp/media/result.jpg" }),
    );

    expect(result.status).toBe("complete");
    const complete = result as MediaAdapterResult & { status: "complete" };
    expect(complete.mime_type).toBe("image/jpeg");
  });

  it("returns error when no image content part in response", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: [
                {
                  type: "text",
                  text: "Here is your image description",
                },
              ],
            },
          },
        ],
      }),
    });

    const result = await openAIChatImageAdapter(makeRequest());

    expect(result.status).toBe("error");
    const error = result as MediaAdapterResult & { status: "error" };
    expect(error.error.length).toBeGreaterThan(0);
  });

  it("error on non-200 response", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      text: vi.fn().mockResolvedValue('{"error":{"message":"Invalid request"}}'),
    });

    const result = await openAIChatImageAdapter(makeRequest());

    expect(result.status).toBe("error");
    const error = result as MediaAdapterResult & { status: "error" };
    expect(error.error.length).toBeGreaterThan(0);
    expect(error.error).toContain("400");
  });

  it("sends correct body: { model, messages: [{role:'user', content: prompt}], modalities: ['text','image'] }", async () => {
    const rawBytes = "test";
    const base64 = Buffer.from(rawBytes).toString("base64");
    mockFetch.mockResolvedValue(makeImageResponse(base64));

    await openAIChatImageAdapter(
      makeRequest({
        model: "gpt-4o-mini",
        prompt: "Generate a beautiful sunset",
        modalities: ["text", "image"],
      }),
    );

    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body as string);

    expect(body.model).toBe("gpt-4o-mini");
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[0].content).toBe("Generate a beautiful sunset");
    expect(body.modalities).toEqual(["text", "image"]);
  });

  it("sends correct auth: Authorization: Bearer {apiKey}", async () => {
    const rawBytes = "test";
    const base64 = Buffer.from(rawBytes).toString("base64");
    mockFetch.mockResolvedValue(makeImageResponse(base64));

    await openAIChatImageAdapter(
      makeRequest({ provider: makeProvider({ apiKey: "my-secret-key" }) }),
    );

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers).toHaveProperty("Authorization", "Bearer my-secret-key");
  });

  it("POSTs to {baseUrl}/chat/completions", async () => {
    const rawBytes = "test";
    const base64 = Buffer.from(rawBytes).toString("base64");
    mockFetch.mockResolvedValue(makeImageResponse(base64));

    await openAIChatImageAdapter(
      makeRequest({ provider: makeProvider({ baseUrl: "https://custom.api.com/v1" }) }),
    );

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("https://custom.api.com/v1/chat/completions");
    expect(url).toContain("/chat/completions");
  });
});
