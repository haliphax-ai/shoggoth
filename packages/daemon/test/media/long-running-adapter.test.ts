import { describe, it, vi, beforeEach, afterEach } from "vitest";
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
import { longRunningAdapter } from "../../src/media/adapters/long-running-adapter";
import type { MediaAdapterRequest, MediaAdapterResult } from "../../src/media/adapters/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(
  overrides?: Partial<MediaAdapterRequest> & { timeout_ms?: number },
): MediaAdapterRequest & { timeout_ms?: number } {
  return {
    model: "veo-3.1-generate-preview",
    prompt: "a sunset timelapse over the ocean",
    apiKey: "test-api-key",
    baseUrl: "https://generativelanguage.googleapis.com",
    outputPath: "/tmp/media/output.mp4",
    params: { kind: "video" as const },
    ...overrides,
  };
}

function makeInitiateResponse(operationName: string, done = false) {
  const body: Record<string, unknown> = {
    name: operationName,
    done,
  };
  if (done) {
    body.response = {
      generateVideoResponse: {
        generatedSamples: [
          {
            video: {
              uri: "https://storage.googleapis.com/fake-video.mp4",
              encoding: "video/mp4",
              bytesBase64Encoded: Buffer.from("fake-video-bytes").toString("base64"),
            },
          },
        ],
      },
    };
  }
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(body),
  };
}

function makePollResponse(done: boolean, operationName = "operations/veo-abc123") {
  const body: Record<string, unknown> = {
    name: operationName,
    done,
  };
  if (done) {
    body.response = {
      generateVideoResponse: {
        generatedSamples: [
          {
            video: {
              uri: "https://storage.googleapis.com/fake-video.mp4",
              encoding: "video/mp4",
              bytesBase64Encoded: Buffer.from("completed-video-bytes").toString("base64"),
            },
          },
        ],
      },
    };
  }
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(body),
  };
}

function makeErrorResponse(status: number, statusText: string, errorMessage: string) {
  return {
    ok: false,
    status,
    statusText,
    text: vi.fn().mockResolvedValue(JSON.stringify({ error: { message: errorMessage } })),
  };
}

// ---------------------------------------------------------------------------
// GeminiLongRunningAdapter
// ---------------------------------------------------------------------------

describe("longRunningAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends correct POST to {baseUrl}/v1beta/models/{model}:predictLongRunning with API key", async () => {
    mockFetch.mockResolvedValueOnce(makeInitiateResponse("operations/veo-abc123", true));

    await longRunningAdapter(makeRequest());

    assert.ok(mockFetch.mock.calls.length >= 1);
    const [url, opts] = mockFetch.mock.calls[0];
    assert.ok(
      url.includes("/v1beta/models/veo-3.1-generate-preview:predictLongRunning"),
      `URL should contain predictLongRunning endpoint, got: ${url}`,
    );
    assert.ok(url.includes("key=test-api-key"), `URL should contain API key, got: ${url}`);
    assert.strictEqual(opts.method, "POST");
    assert.strictEqual(opts.headers["Content-Type"], "application/json");
  });

  it("request body has instances: [{ prompt }] and parameters: { aspectRatio, durationSeconds }", async () => {
    mockFetch.mockResolvedValueOnce(makeInitiateResponse("operations/veo-abc123", true));

    await longRunningAdapter(
      makeRequest({
        params: { kind: "video", aspectRatio: "16:9", durationSeconds: 8 },
      }),
    );

    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);

    assert.deepStrictEqual(body.instances, [{ prompt: "a sunset timelapse over the ocean" }]);
    assert.strictEqual(body.parameters.aspectRatio, "16:9");
    assert.strictEqual(body.parameters.durationSeconds, 8);
  });

  it("when operation completes immediately: parses video from generateVideoResponse, writes file, returns complete", async () => {
    mockFetch.mockResolvedValueOnce(makeInitiateResponse("operations/veo-done", true));

    const result = await longRunningAdapter(makeRequest({ outputPath: "/tmp/media/video.mp4" }));

    assert.strictEqual(result.status, "complete");
    const complete = result as MediaAdapterResult & { status: "complete" };
    assert.strictEqual(complete.path, "/tmp/media/video.mp4");
    assert.ok(complete.mime_type.includes("video"));

    // Should have written the decoded video bytes to disk
    assert.strictEqual(vi.mocked(mkdir).mock.calls.length, 1);
    assert.strictEqual(vi.mocked(writeFile).mock.calls.length, 1);
    const [writePath, writeData] = vi.mocked(writeFile).mock.calls[0];
    assert.strictEqual(writePath, "/tmp/media/video.mp4");
    assert.ok(Buffer.isBuffer(writeData));
    assert.strictEqual(writeData.toString(), "fake-video-bytes");
  });

  it("when operation is still pending after timeout: returns in_progress with operation_id", async () => {
    // Initial POST returns pending operation
    mockFetch.mockResolvedValueOnce(makeInitiateResponse("operations/veo-pending"));
    // All poll responses also return pending
    mockFetch.mockResolvedValue(makePollResponse(false));

    const promise = longRunningAdapter(makeRequest({ timeout_ms: 500 }));

    // Advance timers past the timeout to let polling exhaust
    await vi.advanceTimersByTimeAsync(10_000);

    const result = await promise;

    assert.strictEqual(result.status, "in_progress");
    const inProgress = result as MediaAdapterResult & { status: "in_progress" };
    assert.strictEqual(inProgress.operation_id, "operations/veo-pending");
  });

  it("polls GET {baseUrl}/v1beta/{operationName} at intervals until done", async () => {
    // Initial POST returns pending
    mockFetch.mockResolvedValueOnce(makeInitiateResponse("operations/veo-poll123"));
    // First poll: still pending
    mockFetch.mockResolvedValueOnce(makePollResponse(false, "operations/veo-poll123"));
    // Second poll: still pending
    mockFetch.mockResolvedValueOnce(makePollResponse(false, "operations/veo-poll123"));
    // Third poll: done
    mockFetch.mockResolvedValueOnce(makePollResponse(true, "operations/veo-poll123"));

    const promise = longRunningAdapter(makeRequest({ timeout_ms: 60_000 }));

    // Advance through polling intervals
    await vi.advanceTimersByTimeAsync(60_000);

    const result = await promise;

    assert.strictEqual(result.status, "complete");

    // Verify poll requests used GET with the operation name
    const pollCalls = mockFetch.mock.calls.slice(1); // skip the initial POST
    assert.ok(pollCalls.length >= 1, "Should have made at least one poll request");
    for (const [pollUrl] of pollCalls) {
      assert.ok(
        pollUrl.includes("operations/veo-poll123"),
        `Poll URL should contain operation name, got: ${pollUrl}`,
      );
      assert.ok(
        pollUrl.includes("key=test-api-key"),
        `Poll URL should contain API key, got: ${pollUrl}`,
      );
    }
  });

  it("includes input_image as reference frame when provided", async () => {
    mockFetch.mockResolvedValueOnce(makeInitiateResponse("operations/veo-img2vid", true));

    await longRunningAdapter(
      makeRequest({
        params: { kind: "video", input_image: "/workspace/reference.png" },
      }),
    );

    // readFile should have been called to read the input image
    assert.ok(vi.mocked(readFile).mock.calls.length > 0);
    const readPath = vi.mocked(readFile).mock.calls[0][0];
    assert.strictEqual(readPath, "/workspace/reference.png");

    // The request body should include the image in instances
    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    const instance = body.instances[0];
    assert.ok(
      instance.image?.bytesBase64Encoded || instance.referenceImage?.bytesBase64Encoded,
      "instance should include image data for image-to-video reference frame",
    );
  });

  it("handles API error on initial predictLongRunning request", async () => {
    mockFetch.mockResolvedValueOnce(
      makeErrorResponse(429, "Too Many Requests", "Rate limit exceeded"),
    );

    const result = await longRunningAdapter(makeRequest());

    assert.strictEqual(result.status, "error");
    const error = result as MediaAdapterResult & { status: "error" };
    assert.ok(error.error.length > 0);
    assert.ok(error.error.includes("429"), `Error should mention status code, got: ${error.error}`);
  });

  it("handles API error during polling", async () => {
    // Initial POST succeeds with pending operation
    mockFetch.mockResolvedValueOnce(makeInitiateResponse("operations/veo-pollerr"));
    // Poll returns an error
    mockFetch.mockResolvedValueOnce(
      makeErrorResponse(500, "Internal Server Error", "Something went wrong"),
    );

    const promise = longRunningAdapter(makeRequest({ timeout_ms: 60_000 }));

    await vi.advanceTimersByTimeAsync(60_000);

    const result = await promise;

    assert.strictEqual(result.status, "error");
    const error = result as MediaAdapterResult & { status: "error" };
    assert.ok(error.error.length > 0);
  });

  it("uses default parameters when optional video params are omitted", async () => {
    mockFetch.mockResolvedValueOnce(makeInitiateResponse("operations/veo-defaults", true));

    await longRunningAdapter(makeRequest({ params: { kind: "video" } }));

    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);

    // Parameters object should exist even with defaults
    assert.ok(body.parameters != null, "parameters should be present in request body");
  });

  it("uses custom baseUrl from request", async () => {
    mockFetch.mockResolvedValueOnce(makeInitiateResponse("operations/veo-custom", true));

    await longRunningAdapter(
      makeRequest({
        baseUrl: "https://custom-gemini.example.com",
      }),
    );

    const [url] = mockFetch.mock.calls[0];
    assert.ok(
      url.startsWith("https://custom-gemini.example.com"),
      `URL should use custom baseUrl, got: ${url}`,
    );
  });
});

// ---------------------------------------------------------------------------
// media_generate_poll control op
// ---------------------------------------------------------------------------

// Mock MediaGenerationService for poll op tests
const mockPoll = vi.fn();

vi.mock("../../src/media/media-generation-service", () => ({
  MediaGenerationService: vi.fn().mockImplementation(function () {
    return { generate: vi.fn(), poll: mockPoll };
  }),
}));

// Lazy-import integration-ops after mocks are set up
const { handleIntegrationControlOp, IntegrationOpError } =
  await import("../../src/control/integration-ops");
const { WIRE_VERSION } = await import("@shoggoth/authn");
const { DEFAULT_HITL_CONFIG, DEFAULT_POLICY_CONFIG } = await import("@shoggoth/shared");

import type { IntegrationOpsContext } from "../../src/control/integration-ops";
import type { WireRequest, AuthenticatedPrincipal } from "@shoggoth/authn";
import type { ShoggothConfig } from "@shoggoth/shared";

function agentPrincipal(
  sessionId = "agent:test:discord:channel:00000000-0000-0000-0000-000000000001",
): AuthenticatedPrincipal {
  return { kind: "agent", sessionId };
}

function makeConfig(overrides?: Partial<ShoggothConfig>): ShoggothConfig {
  return {
    logLevel: "info",
    stateDbPath: "/tmp/state.db",
    socketPath: "/tmp/c.sock",
    workspacesRoot: "/tmp/workspaces",
    secretsDirectory: "/tmp/secrets",
    inboundMediaRoot: "/tmp/media",
    operatorDirectory: "/tmp/operator",
    configDirectory: "/tmp/config",
    hitl: DEFAULT_HITL_CONFIG,
    memory: { paths: ["memory"], embeddings: { enabled: false } },
    skills: { scanRoots: ["skills"], disabledIds: [] },
    plugins: [],
    mcp: { servers: [], poolScope: "global" },
    policy: DEFAULT_POLICY_CONFIG,
    models: {
      providers: [
        {
          id: "gemini-default",
          kind: "gemini" as const,
          apiKey: "test-api-key",
          baseUrl: "https://generativelanguage.googleapis.com",
        },
      ],
    },
    ...overrides,
  } as ShoggothConfig;
}

function makeCtx(configOverrides?: Partial<ShoggothConfig>): IntegrationOpsContext {
  return {
    config: makeConfig(configOverrides),
    stateDb: undefined,
    acpxStore: undefined,
    sessions: undefined,
    sessionManager: undefined,
    acpxSupervisor: undefined,
    recordIntegrationAudit: () => {},
  } as unknown as IntegrationOpsContext;
}

function makePollReq(payload: Record<string, unknown>): WireRequest {
  return {
    v: WIRE_VERSION,
    id: "poll-1",
    op: "media_generate_poll",
    payload,
  };
}

describe("media_generate_poll control op", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts provider_id and operation_id, calls poll on the service", async () => {
    mockPoll.mockResolvedValueOnce({
      status: "complete",
      path: "/tmp/media/polled-video.mp4",
      mime_type: "video/mp4",
    });

    const req = makePollReq({
      provider_id: "gemini-default",
      operation_id: "operations/veo-abc123",
    });
    const result = await handleIntegrationControlOp(req, agentPrincipal(), makeCtx());

    assert.ok(result != null);
    assert.ok(mockPoll.mock.calls.length >= 1);
    const callArg = mockPoll.mock.calls[0][0];
    assert.strictEqual(callArg.provider_id, "gemini-default");
    assert.strictEqual(callArg.operation_id, "operations/veo-abc123");
  });

  it("returns complete result when operation is done", async () => {
    mockPoll.mockResolvedValueOnce({
      status: "complete",
      path: "/tmp/media/done-video.mp4",
      mime_type: "video/mp4",
    });

    const req = makePollReq({
      provider_id: "gemini-default",
      operation_id: "operations/veo-done",
    });
    const result = await handleIntegrationControlOp(req, agentPrincipal(), makeCtx());

    assert.ok(result != null);
    const r = result as { status: string; path?: string; mime_type?: string };
    assert.strictEqual(r.status, "complete");
    assert.strictEqual(r.path, "/tmp/media/done-video.mp4");
    assert.strictEqual(r.mime_type, "video/mp4");
  });

  it("returns in_progress when operation is still running", async () => {
    mockPoll.mockResolvedValueOnce({
      status: "in_progress",
      operation_id: "operations/veo-still-going",
    });

    const req = makePollReq({
      provider_id: "gemini-default",
      operation_id: "operations/veo-still-going",
    });
    const result = await handleIntegrationControlOp(req, agentPrincipal(), makeCtx());

    assert.ok(result != null);
    const r = result as { status: string; operation_id?: string };
    assert.strictEqual(r.status, "in_progress");
    assert.strictEqual(r.operation_id, "operations/veo-still-going");
  });

  it("returns error on poll failure", async () => {
    mockPoll.mockResolvedValueOnce({
      status: "error",
      error: "Operation failed: video generation timed out on server",
    });

    const req = makePollReq({
      provider_id: "gemini-default",
      operation_id: "operations/veo-failed",
    });
    const result = await handleIntegrationControlOp(req, agentPrincipal(), makeCtx());

    assert.ok(result != null);
    const r = result as { status: string; error?: string };
    assert.strictEqual(r.status, "error");
    assert.ok(r.error!.includes("failed"));
  });

  it("rejects missing provider_id", async () => {
    const req = makePollReq({ operation_id: "operations/veo-abc123" });
    await assert.rejects(
      () => handleIntegrationControlOp(req, agentPrincipal(), makeCtx()),
      (err: unknown) => {
        assert.ok(err instanceof IntegrationOpError);
        assert.strictEqual(
          (err as InstanceType<typeof IntegrationOpError>).code,
          "ERR_INVALID_PAYLOAD",
        );
        return true;
      },
    );
  });

  it("rejects missing operation_id", async () => {
    const req = makePollReq({ provider_id: "gemini-default" });
    await assert.rejects(
      () => handleIntegrationControlOp(req, agentPrincipal(), makeCtx()),
      (err: unknown) => {
        assert.ok(err instanceof IntegrationOpError);
        assert.strictEqual(
          (err as InstanceType<typeof IntegrationOpError>).code,
          "ERR_INVALID_PAYLOAD",
        );
        return true;
      },
    );
  });

  it("passes output_path through to the poll call when provided", async () => {
    mockPoll.mockResolvedValueOnce({
      status: "complete",
      path: "/tmp/media/custom-output.mp4",
      mime_type: "video/mp4",
    });

    const req = makePollReq({
      provider_id: "gemini-default",
      operation_id: "operations/veo-with-path",
      output_path: "/tmp/media/custom-output.mp4",
    });
    const result = await handleIntegrationControlOp(req, agentPrincipal(), makeCtx());

    assert.ok(result != null);
    const callArg = mockPoll.mock.calls[0][0];
    assert.strictEqual(callArg.output_path, "/tmp/media/custom-output.mp4");
  });

  it("rejects unknown provider_id", async () => {
    const req = makePollReq({
      provider_id: "nonexistent-provider",
      operation_id: "operations/veo-abc123",
    });
    const result = await handleIntegrationControlOp(req, agentPrincipal(), makeCtx());

    assert.ok(result != null);
    const r = result as { status: string; error?: string };
    assert.strictEqual(r.status, "error");
    assert.ok(r.error!.includes("nonexistent-provider"));
  });
});
