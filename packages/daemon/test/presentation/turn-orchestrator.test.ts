import { describe, it, expect, vi, beforeEach } from "vitest";
import { setNoticeResolver } from "../../src/presentation/notices";
import { PresentationTurnOrchestrator } from "../../src/presentation/turn-orchestrator";
import type { PlatformAdapter, StreamHandle } from "../../src/presentation/platform-adapter";
import type { ShoggothConfig } from "@shoggoth/shared";

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
    expect((orch as any).streamingIntervalMs).toBe(0);
  });

  it("uses provided streamingIntervalMs", () => {
    const adapter = createMockAdapter();
    const orch = new PresentationTurnOrchestrator({
      config: {} as ShoggothConfig,
      adapter,
      streamingIntervalMs: 500,
    });
    expect((orch as any).streamingIntervalMs).toBe(500);
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
    const mockHandle: StreamHandle = { setFullContent: vi.fn().mockResolvedValue(undefined) };
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

    const call = (runInboundSessionTurn as any).mock.calls.at(-1)?.[0];
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

    const call = (runInboundSessionTurn as any).mock.calls.at(-1)?.[0];
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

    const call = (runInboundSessionTurn as any).mock.calls.at(-1)?.[0];
    expect(call.sliceDisplayText("hello world!")).toBe("hello worl");
    expect(call.sliceDisplayText("short")).toBe("short");
  });
});
