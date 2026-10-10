import { describe, it, expect, vi, beforeEach } from "vitest";
import { setNoticeResolver } from "../../src/presentation/notices";
import { PresentationTurnOrchestrator } from "../../src/presentation/turn-orchestrator";
import type { PlatformAdapter, StreamHandle } from "../../src/presentation/platform-adapter";
import { DEFAULT_STATUS_BAR_CONFIG, type ResolvedStatusBarConfig } from "@shoggoth/shared";
import type { ShoggothConfig } from "@shoggoth/shared";
import type { MessageAttachment } from "@shoggoth/messaging";
import type { ImageBlockCodec } from "@shoggoth/models";

// Minimal notice resolver
beforeEach(() => {
  setNoticeResolver((key) => `[${key}]`);
});

function createMockAdapter(overrides: Partial<PlatformAdapter> = {}): PlatformAdapter {
  return {
    sendBody: vi.fn().mockResolvedValue(undefined),
    sendError: vi.fn().mockResolvedValue(undefined),
    maxBodyLength: 2000,
    capabilities: {},
    ...overrides,
  };
}

// We need to mock runInboundSessionTurn since it's the core dependency.
// The orchestrator delegates to it, so we verify the wiring.
vi.mock("../../src/messaging/inbound-session-turn.js", () => ({
  runInboundSessionTurn: vi.fn().mockResolvedValue(undefined),
}));

// Mock downloadInboundAttachments — used by the orchestrator in download/hybrid modes.
vi.mock("../../src/presentation/attachment-download.js", () => ({
  downloadInboundAttachments: vi
    .fn()
    .mockImplementation(async (opts: { attachments: readonly MessageAttachment[] }) =>
      opts.attachments.map((a) => ({
        ...a,
        localPath: `media/inbound/msg123_${a.filename}`,
      })),
    ),
}));

// Mock resolveAttachmentHandlingMode — the orchestrator should call this.
vi.mock("../../src/presentation/attachment-mode.js", () => ({
  resolveAttachmentHandlingMode: vi.fn().mockReturnValue("download"),
}));

// Mock ingestAttachmentImage — used by enrichTurnWithImageAttachments in inline/hybrid modes.
vi.mock("../../src/presentation/image-ingest.js", () => ({
  ingestAttachmentImage: vi.fn().mockImplementation(async (att: MessageAttachment) => {
    // Only produce image blocks for image content types
    if (att.contentType?.startsWith("image/")) {
      return { type: "image", mediaType: att.contentType, base64: "AAAA" };
    }
    return null;
  }),
}));

describe("PresentationTurnOrchestrator", () => {
  it("constructs with required deps", () => {
    const adapter = createMockAdapter();
    const orch = new PresentationTurnOrchestrator({
      config: {} as ShoggothConfig,
      adapter,
    });
    expect(orch).toBeDefined();
  });

  it("defaults streamingIntervalMs to 0", async () => {
    const adapter = createMockAdapter();
    const orch = new PresentationTurnOrchestrator({
      config: {} as ShoggothConfig,
      adapter,
    });

    // Access private field via any to verify default
    expect((orch as unknown as { streamingIntervalMs: number }).streamingIntervalMs).toBe(0);
  });

  it("uses provided streamingIntervalMs", () => {
    const adapter = createMockAdapter();
    const orch = new PresentationTurnOrchestrator({
      config: {} as ShoggothConfig,
      adapter,
      streamingIntervalMs: 500,
    });
    expect((orch as unknown as { streamingIntervalMs: number }).streamingIntervalMs).toBe(500);
  });

  it("orchestrateInboundTurn calls runInboundSessionTurn", async () => {
    const { runInboundSessionTurn } = await import("../../src/messaging/inbound-session-turn.js");
    const adapter = createMockAdapter();
    const orch = new PresentationTurnOrchestrator({
      config: {} as ShoggothConfig,
      adapter,
    });

    await orch.orchestrateInboundTurn({
      sessionId: "s1",
      buildTurn: vi.fn().mockResolvedValue({}),
    });

    expect(runInboundSessionTurn).toHaveBeenCalled();
  });

  it("configures streaming when adapter has startStream and interval > 0", async () => {
    const { runInboundSessionTurn } = await import("../../src/messaging/inbound-session-turn.js");
    const mockHandle: StreamHandle = {
      setFullContent: vi.fn().mockResolvedValue(undefined),
    };
    const adapter = createMockAdapter({
      startStream: vi.fn().mockResolvedValue(mockHandle),
    });
    const orch = new PresentationTurnOrchestrator({
      config: {} as ShoggothConfig,
      adapter,
      streamingIntervalMs: 400,
    });

    await orch.orchestrateInboundTurn({
      sessionId: "s1",
      buildTurn: vi.fn().mockResolvedValue({}),
    });

    const call = vi.mocked(runInboundSessionTurn).mock.calls.at(-1)?.[0];
    expect(call.streaming).toBeDefined();
    expect(call.streaming.minIntervalMs).toBe(400);
  });

  it("does not configure streaming when interval is 0", async () => {
    const { runInboundSessionTurn } = await import("../../src/messaging/inbound-session-turn.js");
    const adapter = createMockAdapter({
      startStream: vi.fn(),
    });
    const orch = new PresentationTurnOrchestrator({
      config: {} as ShoggothConfig,
      adapter,
      streamingIntervalMs: 0,
    });

    await orch.orchestrateInboundTurn({
      sessionId: "s1",
      buildTurn: vi.fn().mockResolvedValue({}),
    });

    const call = vi.mocked(runInboundSessionTurn).mock.calls.at(-1)?.[0];
    expect(call.streaming).toBeUndefined();
  });

  it("sliceDisplayText truncates to maxBodyLength", async () => {
    const { runInboundSessionTurn } = await import("../../src/messaging/inbound-session-turn.js");
    const adapter = createMockAdapter({ maxBodyLength: 10 });
    const orch = new PresentationTurnOrchestrator({
      config: {} as ShoggothConfig,
      adapter,
    });

    await orch.orchestrateInboundTurn({
      sessionId: "s1",
      buildTurn: vi.fn().mockResolvedValue({}),
    });

    const call = vi.mocked(runInboundSessionTurn).mock.calls.at(-1)?.[0];
    expect(call.sliceDisplayText("hello world!")).toBe("hello worl");
    expect(call.sliceDisplayText("short")).toBe("short");
  });

  it("passes the statusBar dep through to runInboundSessionTurn", async () => {
    const { runInboundSessionTurn } = await import("../../src/messaging/inbound-session-turn.js");
    const config = { ...DEFAULT_STATUS_BAR_CONFIG } as ResolvedStatusBarConfig;
    const render = vi.fn();
    const attachSink = vi.fn();
    const adapter = createMockAdapter();
    const orch = new PresentationTurnOrchestrator({
      config: {} as ShoggothConfig,
      adapter,
      statusBar: { config, render, attachSink },
    });

    await orch.orchestrateInboundTurn({
      sessionId: "s1",
      buildTurn: vi.fn().mockResolvedValue({}),
    });

    const call = vi.mocked(runInboundSessionTurn).mock.calls.at(-1)?.[0];
    expect(call.statusBar).toBeDefined();
    expect(call.statusBar.config).toBe(config);
    expect(call.statusBar.render).toBe(render);
    expect(call.statusBar.attachSink).toBe(attachSink);
  });

  it("wraps stream handles with attachSink so handle.setStatusBar applies", async () => {
    const { runInboundSessionTurn } = await import("../../src/messaging/inbound-session-turn.js");
    const config = { ...DEFAULT_STATUS_BAR_CONFIG } as ResolvedStatusBarConfig;
    const render = vi.fn();

    const baseHandle: StreamHandle = {
      setFullContent: vi.fn().mockResolvedValue(undefined),
      pushUpdate: vi.fn().mockResolvedValue(undefined),
    };
    const sink = { setStatusBar: vi.fn().mockResolvedValue(undefined) };
    const attachSink = vi.fn().mockReturnValue(sink);
    const adapter = createMockAdapter({
      startStream: vi.fn().mockResolvedValue(baseHandle),
    });
    const orch = new PresentationTurnOrchestrator({
      config: {} as ShoggothConfig,
      adapter,
      streamingIntervalMs: 400,
      statusBar: { config, render, attachSink },
    });

    await orch.orchestrateInboundTurn({
      sessionId: "s1",
      buildTurn: vi.fn().mockResolvedValue({}),
    });

    const call = vi.mocked(runInboundSessionTurn).mock.calls.at(-1)?.[0];
    expect(call.statusBar).toBeDefined();
    // The start() function wraps the stream handle with attachSink so the
    // returned handle carries the applied setStatusBar method.
    const wrapped = await call.streaming.start();
    expect(attachSink).toHaveBeenCalledWith(baseHandle);
    expect(wrapped.setStatusBar).toBeInstanceOf(Function);
  });
});

// ---------------------------------------------------------------------------
// Mode-aware attachment handling in wrappedBuildTurn
// ---------------------------------------------------------------------------

describe("PresentationTurnOrchestrator — mode-aware attachment handling", () => {
  const sessionId = "agent:myagent:discord:channel:123";

  function makeAttachment(overrides: Partial<MessageAttachment> = {}): MessageAttachment {
    return {
      id: "att-1",
      url: "https://cdn.example.com/photo.png",
      filename: "photo.png",
      contentType: "image/png",
      sizeBytes: 1024,
      ...overrides,
    };
  }

  function makeCodec(supportsUrl = false): ImageBlockCodec {
    return {
      supportsUrl,
      encode: vi.fn(),
      decode: vi.fn(),
    };
  }

  /**
   * Helper: orchestrate a turn with attachments and capture the wrappedBuildTurn
   * output by intercepting the mocked runInboundSessionTurn's buildTurn arg.
   */
  async function orchestrateAndCaptureBuildTurn(opts: {
    mode: "download" | "inline" | "hybrid";
    attachments: readonly MessageAttachment[];
    codec?: ImageBlockCodec;
    formatAttachmentMetadata?: (atts: readonly MessageAttachment[]) => string;
    imageUrlPassthrough?: boolean;
  }) {
    const { runInboundSessionTurn } = await import("../../src/messaging/inbound-session-turn.js");
    const { resolveAttachmentHandlingMode } =
      await import("../../src/presentation/attachment-mode.js");

    // Configure the mode mock for this test
    vi.mocked(resolveAttachmentHandlingMode).mockReturnValue(opts.mode);

    const adapter = createMockAdapter();
    const config = {} as ShoggothConfig;
    const orch = new PresentationTurnOrchestrator({ config, adapter });

    const baseTurn = { sessionId, userContent: "Hello" };

    await orch.orchestrateInboundTurn({
      sessionId,
      buildTurn: vi.fn().mockResolvedValue(baseTurn),
      attachments: opts.attachments,
      imageBlockCodec: opts.codec,
      formatAttachmentMetadata: opts.formatAttachmentMetadata,
      imageUrlPassthrough: opts.imageUrlPassthrough,
    });

    // Extract the wrappedBuildTurn that was passed to runInboundSessionTurn
    const lastCall = vi.mocked(runInboundSessionTurn).mock.calls.at(-1)?.[0];
    expect(lastCall).toBeDefined();
    expect(lastCall.buildTurn).toBeInstanceOf(Function);

    // Invoke the wrappedBuildTurn to get the enriched turn
    const enrichedTurn = await lastCall.buildTurn();
    return enrichedTurn;
  }

  beforeEach(async () => {
    const { runInboundSessionTurn } = await import("../../src/messaging/inbound-session-turn.js");
    vi.mocked(runInboundSessionTurn).mockClear();

    const { downloadInboundAttachments } =
      await import("../../src/presentation/attachment-download.js");
    vi.mocked(downloadInboundAttachments).mockClear();

    const { resolveAttachmentHandlingMode } =
      await import("../../src/presentation/attachment-mode.js");
    vi.mocked(resolveAttachmentHandlingMode).mockClear();
  });

  // -----------------------------------------------------------------------
  // download mode
  // -----------------------------------------------------------------------

  describe("download mode", () => {
    it("does NOT produce image blocks for image attachments", async () => {
      const codec = makeCodec();
      const attachments = [makeAttachment()];
      const formatMeta = (atts: readonly MessageAttachment[]) =>
        atts.map((a) => `- ${a.filename}${a.localPath ? ` → ${a.localPath}` : ""}`).join("\n");

      const turn = await orchestrateAndCaptureBuildTurn({
        mode: "download",
        attachments,
        codec,
        formatAttachmentMetadata: formatMeta,
      });

      // In download mode, userContent should be plain text (not JSON with image blocks).
      // The current code always inlines images when a codec is present, so this will FAIL.
      let parsed: unknown;
      try {
        parsed = JSON.parse(turn.userContent);
      } catch {
        parsed = null;
      }

      if (Array.isArray(parsed)) {
        // If it parsed as an array, there should be NO image-type entries
        const imageBlocks = parsed.filter((p: { type: string }) => p.type === "image");
        expect(imageBlocks).toHaveLength(0);
      }

      // The metadata should include file paths from the download step
      expect(turn.userContent).toContain("media/inbound/");
      expect(turn.userContent).toContain("photo.png");
    });

    it("calls downloadInboundAttachments for image attachments", async () => {
      const { downloadInboundAttachments } =
        await import("../../src/presentation/attachment-download.js");
      const codec = makeCodec();
      const attachments = [makeAttachment()];
      const formatMeta = (atts: readonly MessageAttachment[]) =>
        atts.map((a) => `- ${a.filename}`).join("\n");

      await orchestrateAndCaptureBuildTurn({
        mode: "download",
        attachments,
        codec,
        formatAttachmentMetadata: formatMeta,
      });

      // The orchestrator should call downloadInboundAttachments in download mode.
      // Current code never calls it → FAIL.
      expect(downloadInboundAttachments).toHaveBeenCalled();
    });

    it("appends metadata with localPath to userContent instead of image blocks", async () => {
      const codec = makeCodec();
      const attachments = [
        makeAttachment({ filename: "photo.png", contentType: "image/png" }),
        makeAttachment({ id: "att-2", filename: "data.csv", contentType: "text/csv" }),
      ];
      const formatMeta = (atts: readonly MessageAttachment[]) => {
        const header = `[message has ${atts.length} attachment(s)]`;
        const lines = atts.map((a) => `- ${a.filename}${a.localPath ? ` → ${a.localPath}` : ""}`);
        return [header, ...lines].join("\n");
      };

      const turn = await orchestrateAndCaptureBuildTurn({
        mode: "download",
        attachments,
        codec,
        formatAttachmentMetadata: formatMeta,
      });

      // Should contain the original user text
      expect(turn.userContent).toContain("Hello");
      // Should contain metadata with file paths (from downloadInboundAttachments mock)
      expect(turn.userContent).toContain("media/inbound/msg123_photo.png");
      expect(turn.userContent).toContain("media/inbound/msg123_data.csv");
      // Should NOT be a JSON array (no image blocks)
      expect(turn.userContent.startsWith("[{")).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // inline mode
  // -----------------------------------------------------------------------

  describe("inline mode", () => {
    it("does NOT call downloadInboundAttachments", async () => {
      const { downloadInboundAttachments } =
        await import("../../src/presentation/attachment-download.js");
      const codec = makeCodec();
      const _imgBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      // We need to mock ingestAttachmentImage indirectly — the real function
      // will be called. For inline mode the key assertion is that download is NOT called.
      const attachments = [makeAttachment()];

      await orchestrateAndCaptureBuildTurn({
        mode: "inline",
        attachments,
        codec,
      });

      // In inline mode, no download should happen.
      // Current code never calls downloadInboundAttachments, but it also never
      // calls resolveAttachmentHandlingMode. The test verifies the orchestrator
      // checks the mode and skips download for "inline".
      expect(downloadInboundAttachments).not.toHaveBeenCalled();
    });

    it("produces image blocks for image attachments (current behavior)", async () => {
      const codec = makeCodec();
      const attachments = [makeAttachment()];

      const _turn = await orchestrateAndCaptureBuildTurn({
        mode: "inline",
        attachments,
        codec,
      });

      // Inline mode should produce image blocks (JSON-serialized ChatContentPart[]).
      // This is the current behavior, but the test also implicitly requires
      // resolveAttachmentHandlingMode to be called (which it currently isn't).
      const { resolveAttachmentHandlingMode } =
        await import("../../src/presentation/attachment-mode.js");
      expect(resolveAttachmentHandlingMode).toHaveBeenCalledWith(expect.anything(), sessionId);
    });

    it("does not include localPath in metadata for non-image attachments", async () => {
      const codec = makeCodec();
      const attachments = [
        makeAttachment({ id: "att-2", filename: "report.csv", contentType: "text/csv" }),
      ];
      const formatMeta = (atts: readonly MessageAttachment[]) =>
        atts.map((a) => `- ${a.filename}${a.localPath ? ` → ${a.localPath}` : ""}`).join("\n");

      const turn = await orchestrateAndCaptureBuildTurn({
        mode: "inline",
        attachments,
        codec,
        formatAttachmentMetadata: formatMeta,
      });

      // In inline mode, attachments should NOT have localPath (no download step).
      expect(turn.userContent).not.toContain("media/inbound/");
    });
  });

  // -----------------------------------------------------------------------
  // hybrid mode
  // -----------------------------------------------------------------------

  describe("hybrid mode", () => {
    it("calls downloadInboundAttachments AND produces image blocks", async () => {
      const { downloadInboundAttachments } =
        await import("../../src/presentation/attachment-download.js");
      const codec = makeCodec();
      const attachments = [makeAttachment()];

      const turn = await orchestrateAndCaptureBuildTurn({
        mode: "hybrid",
        attachments,
        codec,
      });

      // Hybrid mode: download should be called
      expect(downloadInboundAttachments).toHaveBeenCalled();

      // AND image blocks should be present (JSON-serialized)
      let parsed: unknown;
      try {
        parsed = JSON.parse(turn.userContent);
      } catch {
        parsed = null;
      }
      expect(Array.isArray(parsed)).toBe(true);
      if (Array.isArray(parsed)) {
        const imageBlocks = parsed.filter((p: { type: string }) => p.type === "image");
        expect(imageBlocks.length).toBeGreaterThan(0);
      }
    });

    it("includes file paths in metadata alongside image blocks", async () => {
      const codec = makeCodec();
      const attachments = [
        makeAttachment({ filename: "photo.png", contentType: "image/png" }),
        makeAttachment({ id: "att-2", filename: "notes.txt", contentType: "text/plain" }),
      ];
      const formatMeta = (atts: readonly MessageAttachment[]) => {
        const header = `[message has ${atts.length} attachment(s)]`;
        const lines = atts.map((a) => `- ${a.filename}${a.localPath ? ` → ${a.localPath}` : ""}`);
        return [header, ...lines].join("\n");
      };

      const turn = await orchestrateAndCaptureBuildTurn({
        mode: "hybrid",
        attachments,
        codec,
        formatAttachmentMetadata: formatMeta,
      });

      // Hybrid mode should have file paths from the download step
      expect(turn.userContent).toContain("media/inbound/");
    });
  });

  // -----------------------------------------------------------------------
  // resolveAttachmentHandlingMode is called
  // -----------------------------------------------------------------------

  it("calls resolveAttachmentHandlingMode with config and sessionId when attachments are present", async () => {
    const { resolveAttachmentHandlingMode } =
      await import("../../src/presentation/attachment-mode.js");
    vi.mocked(resolveAttachmentHandlingMode).mockReturnValue("download");

    const codec = makeCodec();
    const attachments = [makeAttachment()];
    const formatMeta = (atts: readonly MessageAttachment[]) =>
      atts.map((a) => `- ${a.filename}`).join("\n");

    await orchestrateAndCaptureBuildTurn({
      mode: "download",
      attachments,
      codec,
      formatAttachmentMetadata: formatMeta,
    });

    // The orchestrator should resolve the mode from config.
    // Current code never calls resolveAttachmentHandlingMode → FAIL.
    expect(resolveAttachmentHandlingMode).toHaveBeenCalledWith(
      expect.anything(), // config
      sessionId,
    );
  });
});
