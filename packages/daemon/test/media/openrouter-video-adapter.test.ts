import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { openrouterVideoAdapter } from "../../src/media/adapters/openrouter-video-adapter";

describe("openrouterVideoAdapter", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const baseReq = {
    provider: { apiKey: "test-key", baseUrl: "https://api.openrouter.ai" },
    model: "deepseek/video-1",
    prompt: "Generate a test video",
    params: { kind: "video" as const, durationSeconds: 5, aspectRatio: "16:9" },
    outputPath: `/tmp/test-openrouter-video-${Date.now()}`,
  };

  // Test 1: Successful generation
  it("should return complete status when generation succeeds", async () => {
    const outputPath = `/tmp/test-openrouter-video-${Date.now()}`;

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "job-123",
          polling_url: "https://api.openrouter.ai/jobs/job-123",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "job-123",
          status: "completed",
          unsigned_urls: ["https://cdn.example.com/video.mp4"],
        }),
        headers: new Headers(),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(100),
      });

    const result = await openrouterVideoAdapter({
      ...baseReq,
      outputPath,
      params: { kind: "video", durationSeconds: 5, aspectRatio: "16:9" },
    });

    expect(result.status).toBe("complete");
    expect(result.path).toBe(outputPath);
  });

  // Test 2: Submit failure
  it("should return error when submit fails", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    });

    const result = await openrouterVideoAdapter({
      ...baseReq,
      outputPath: `/tmp/test-openrouter-video-${Date.now()}`,
    });

    expect(result.status).toBe("error");
    expect(result.error).toContain("500");
  });

  // Test 3: Poll returns failed
  it("should return error when poll returns failed status", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "job-123",
          polling_url: "https://api.openrouter.ai/jobs/job-123",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "job-123", status: "failed", error: "Content policy violation" }),
        headers: new Headers(),
      });

    const result = await openrouterVideoAdapter({
      ...baseReq,
      outputPath: `/tmp/test-openrouter-video-${Date.now()}`,
    });

    expect(result.status).toBe("error");
    expect(result.error).toBe("Content policy violation");
  });

  // Test 4: Timeout
  it("should return in_progress when polling times out", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "job-123",
          polling_url: "https://api.openrouter.ai/jobs/job-123",
        }),
      })
      // Return pending multiple times to trigger timeout
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "job-123", status: "in_progress" }),
        headers: new Headers(),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "job-123", status: "pending" }),
        headers: new Headers(),
      });

    const result = await openrouterVideoAdapter({
      ...baseReq,
      outputPath: `/tmp/test-openrouter-video-${Date.now()}`,
      adapterDefaults: { timeoutMs: 100, pollIntervalMs: 50 },
    });

    expect(result.status).toBe("in_progress");
    expect(result.operation_id).toBe("job-123");
  });

  // Test 5: Frame images
  it("should include frame_images in submit request when input_image provided", async () => {
    const outputPath = `/tmp/test-openrouter-video-${Date.now()}`;
    let submitBody: unknown;

    mockFetch.mockImplementation(async (url, options) => {
      const urlStr = url.toString();
      if (urlStr.includes("/videos") && options?.method === "POST") {
        submitBody = JSON.parse(options.body as string);
        return {
          ok: true,
          json: async () => ({
            id: "job-123",
            polling_url: "https://api.openrouter.ai/jobs/job-123",
          }),
        };
      }
      // Poll and download
      return {
        ok: true,
        json: async () => ({
          id: "job-123",
          status: "completed",
          unsigned_urls: ["https://cdn.example.com/video.mp4"],
        }),
        headers: new Headers(),
        arrayBuffer: async () => new ArrayBuffer(100),
      };
    });

    await openrouterVideoAdapter({
      ...baseReq,
      outputPath,
      params: { kind: "video", durationSeconds: 5, aspectRatio: "16:9", input_image: "SGVsbG8=" },
    });

    expect(submitBody).toBeDefined();
    expect((submitBody as Record<string, unknown>).frame_images).toEqual([
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,SGVsbG8=" },
        frame_type: "first_frame",
      },
    ]);
  });
});
