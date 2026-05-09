import { describe, it, vi, beforeEach, afterEach, expect } from "vitest";

// Mock node:fs/promises for file writing
vi.mock("node:fs/promises", () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { writeFile, mkdir } from "node:fs/promises";
import { openaiVideoAsyncAdapter } from "../../src/media/adapters/openai-video-async-adapter";
import type { MediaAdapterRequest, MediaAdapterResult } from "../../src/media/adapters/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(
  overrides?: Partial<MediaAdapterRequest> & {
    adapterDefaults?: { pollIntervalMs?: number; timeoutMs?: number };
  },
): MediaAdapterRequest & { adapterDefaults?: { pollIntervalMs?: number; timeoutMs?: number } } {
  return {
    model: "gpt-video-1",
    prompt: "A cat playing in the snow",
    provider: {
      id: "openai-test",
      kind: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "test-api-key",
    },
    outputPath: "/tmp/media/output.mp4",
    params: { kind: "video" as const },
    ...overrides,
  };
}

/** Mock response for successful submit with generation_id in body */
function makeSubmitResponse(generationId: string, includeHeader = false) {
  const headers: Record<string, string> = {};
  if (includeHeader) {
    headers["X-Generation-Id"] = generationId;
  }

  const body: Record<string, unknown> = {
    id: generationId,
    object: "generation",
    created: Date.now(),
    model: "gpt-video-1",
    status: "pending",
  };

  return {
    ok: true,
    status: 200,
    headers: new Headers(headers),
    json: vi.fn().mockResolvedValue(body),
  };
}

/** Mock response for submit with generation_id only in header (not in body) */
function makeSubmitResponseHeaderOnly(generationId: string) {
  const body: Record<string, unknown> = {
    // No 'id' field in body
    object: "generation",
    created: Date.now(),
    model: "gpt-video-1",
    status: "pending",
  };

  return {
    ok: true,
    status: 200,
    headers: new Headers({ "X-Generation-Id": generationId }),
    json: vi.fn().mockResolvedValue(body),
  };
}

/** Mock poll response for pending */
function makePollPendingResponse() {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({
      id: "gen-abc123",
      status: "pending",
    }),
  };
}

/** Mock poll response for complete with video_url */
function makePollCompleteResponse(videoUrl = "https://storage.example.com/video.mp4") {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({
      id: "gen-abc123",
      status: "complete",
      video_url: videoUrl,
    }),
  };
}

/** Mock video download response */
function makeVideoDownloadResponse(content = "fake-video-bytes") {
  return {
    ok: true,
    status: 200,
    arrayBuffer: vi.fn().mockResolvedValue(new Uint8Array(Buffer.from(content)).buffer),
  };
}

/** Mock error response */
function makeErrorResponse(status: number, statusText: string) {
  return {
    ok: false,
    status,
    statusText,
    text: vi.fn().mockResolvedValue(statusText),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("openaiVideoAsyncAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("submit + immediate completion", () => {
    it("submits generation and immediately polls complete, downloads video, writes file", async () => {
      const generationId = "gen-immediate-123";
      mockFetch
        .mockResolvedValueOnce(makeSubmitResponse(generationId))
        .mockResolvedValueOnce(makePollCompleteResponse())
        .mockResolvedValueOnce(makeVideoDownloadResponse("downloaded-video-bytes"));

      const result = await openaiVideoAsyncAdapter(
        makeRequest({ outputPath: "/tmp/media/video.mp4" }),
      );

      expect(result.status).toBe("complete");
      const complete = result as MediaAdapterResult & { status: "complete" };
      expect(complete.path).toBe("/tmp/media/video.mp4");
      expect(complete.mime_type).toContain("video");

      // Verify file was written
      expect(writeFile).toHaveBeenCalledTimes(1);
      const [writePath, writeData] = (writeFile as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(writePath).toBe("/tmp/media/video.mp4");
      expect(Buffer.isBuffer(writeData)).toBe(true);
      expect(writeData.toString()).toBe("downloaded-video-bytes");
    });
  });

  describe("multiple polls before completion", () => {
    it("polls multiple times until status becomes complete", async () => {
      const generationId = "gen-multi-poll-456";
      mockFetch
        .mockResolvedValueOnce(makeSubmitResponse(generationId))
        .mockResolvedValueOnce(makePollPendingResponse()) // First poll: pending
        .mockResolvedValueOnce(makePollPendingResponse()) // Second poll: pending
        .mockResolvedValueOnce(makePollCompleteResponse()) // Third poll: complete
        .mockResolvedValueOnce(makeVideoDownloadResponse());

      const promise = openaiVideoAsyncAdapter(
        makeRequest({ outputPath: "/tmp/media/multi-poll.mp4" }),
      );

      // Advance through polling intervals
      await vi.advanceTimersByTimeAsync(20_000);

      const result = await promise;

      expect(result.status).toBe("complete");

      // Verify 3 poll calls were made (excluding submit and download)
      const pollCalls = mockFetch.mock.calls.filter(([url]: [string]) =>
        url.includes("/generation?"),
      );
      expect(pollCalls.length).toBe(3);
    });
  });

  describe("timeout behavior", () => {
    it("returns in_progress with operation_id when timeout is exceeded", async () => {
      const generationId = "gen-timeout-789";
      mockFetch
        .mockResolvedValueOnce(makeSubmitResponse(generationId))
        .mockResolvedValue(makePollPendingResponse()); // Always pending

      const promise = openaiVideoAsyncAdapter(
        makeRequest({
          adapterDefaults: { timeoutMs: 500 }, // Short timeout for test
        }),
      );

      // Advance timers past the timeout
      await vi.advanceTimersByTimeAsync(10_000);

      const result = await promise;

      expect(result.status).toBe("in_progress");
      const inProgress = result as MediaAdapterResult & { status: "in_progress" };
      expect(inProgress.operation_id).toBe(generationId);
    });
  });

  describe("generation_id extraction", () => {
    it("extracts generation_id from response body id field", async () => {
      const generationId = "gen-body-id-123";
      mockFetch
        .mockResolvedValueOnce(makeSubmitResponse(generationId, false)) // id in body
        .mockResolvedValueOnce(makePollCompleteResponse())
        .mockResolvedValueOnce(makeVideoDownloadResponse());

      await openaiVideoAsyncAdapter(makeRequest());

      // The poll should use the generation_id from body
      const pollCall = mockFetch.mock.calls.find(([url]: [string]) => url.includes("/generation?"));
      expect(pollCall).toBeDefined();
      const pollUrl = pollCall![0] as string;
      expect(pollUrl).toContain(`id=${generationId}`);
    });

    it("extracts generation_id from X-Generation-Id header as fallback", async () => {
      const generationId = "gen-header-only-456";
      mockFetch
        .mockResolvedValueOnce(makeSubmitResponseHeaderOnly(generationId)) // id only in header
        .mockResolvedValueOnce(makePollCompleteResponse())
        .mockResolvedValueOnce(makeVideoDownloadResponse());

      await openaiVideoAsyncAdapter(makeRequest());

      // The poll should use the generation_id from header
      const pollCall = mockFetch.mock.calls.find(([url]: [string]) => url.includes("/generation?"));
      expect(pollCall).toBeDefined();
      const pollUrl = pollCall![0] as string;
      expect(pollUrl).toContain(`id=${generationId}`);
    });
  });

  describe("error handling", () => {
    it("returns error on failed submit (non-200)", async () => {
      mockFetch.mockResolvedValueOnce(makeErrorResponse(429, "Rate limit exceeded"));

      const result = await openaiVideoAsyncAdapter(makeRequest());

      expect(result.status).toBe("error");
      const error = result as MediaAdapterResult & { status: "error" };
      expect(error.error).toContain("429");
    });
  });

  describe("video download on completion", () => {
    it("downloads video_url and writes to outputPath on completion", async () => {
      const generationId = "gen-download-123";
      const videoUrl = "https://storage.example.com/my-video.mp4";
      mockFetch
        .mockResolvedValueOnce(makeSubmitResponse(generationId))
        .mockResolvedValueOnce(makePollCompleteResponse(videoUrl))
        .mockResolvedValueOnce(makeVideoDownloadResponse("final-video-bytes"));

      const result = await openaiVideoAsyncAdapter(
        makeRequest({ outputPath: "/tmp/media/final-output.mp4" }),
      );

      expect(result.status).toBe("complete");
      const complete = result as MediaAdapterResult & { status: "complete" };
      expect(complete.path).toBe("/tmp/media/final-output.mp4");

      // Verify mkdir and writeFile were called
      expect(mkdir).toHaveBeenCalled();
      expect(writeFile).toHaveBeenCalledWith("/tmp/media/final-output.mp4", expect.any(Buffer));
    });
  });
});
