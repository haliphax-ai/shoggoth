import { describe, it, expect } from "vitest";
import { renderDiscordStatusBar } from "../src/status-bar";
import type { StatusBarSnapshot } from "@shoggoth/daemon/lib";
import { DEFAULT_STATUS_BAR_CONFIG, type ResolvedStatusBarConfig } from "@shoggoth/shared";

const defaultCfg: ResolvedStatusBarConfig = { ...DEFAULT_STATUS_BAR_CONFIG };

function snap(overrides: Partial<StatusBarSnapshot> = {}): StatusBarSnapshot {
  return {
    phase: "starting",
    sequence: 1,
    toolCalls: { total: 0 },
    compactions: 0,
    ...overrides,
  };
}

describe("renderDiscordStatusBar", () => {
  it("renders the starting status emoji", () => {
    expect(renderDiscordStatusBar(snap(), defaultCfg)).toContain("⏳");
  });

  it("renders the thinking status emoji", () => {
    expect(renderDiscordStatusBar(snap({ phase: "thinking" }), defaultCfg)).toContain("🧠");
  });

  it("renders the prose status emoji", () => {
    expect(renderDiscordStatusBar(snap({ phase: "prose" }), defaultCfg)).toContain("💬");
  });

  it("renders the tool status emoji", () => {
    expect(renderDiscordStatusBar(snap({ phase: "tool" }), defaultCfg)).toContain("⚡");
  });

  it("renders the paused status emoji", () => {
    expect(renderDiscordStatusBar(snap({ phase: "paused" }), defaultCfg)).toContain("⏸️");
  });

  it("renders the finished status emoji", () => {
    expect(renderDiscordStatusBar(snap({ phase: "finished" }), defaultCfg)).toContain("✅");
  });

  it("renders the aborted status emoji", () => {
    expect(renderDiscordStatusBar(snap({ phase: "aborted" }), defaultCfg)).toContain("🛑");
  });

  it("renders the failed status emoji", () => {
    expect(renderDiscordStatusBar(snap({ phase: "failed" }), defaultCfg)).toContain("❌");
  });

  it("renders the sequence with the sequence emoji", () => {
    const line = renderDiscordStatusBar(snap({ sequence: 217 }), defaultCfg);
    expect(line).toContain("🔢");
    expect(line).toContain("217");
  });

  it("omits the tool section when total is 0 and no queued tool", () => {
    const line = renderDiscordStatusBar(snap({ toolCalls: { total: 0 } }), defaultCfg);
    expect(line).not.toContain("🔧");
  });

  it("shows a running tool in bold", () => {
    const line = renderDiscordStatusBar(
      snap({
        phase: "tool",
        toolCalls: {
          total: 1,
          last: { name: "builtin-exec:bash", running: true },
        },
      }),
      defaultCfg,
    );
    expect(line).toContain("🔧");
    expect(line).toContain("**builtin-exec:bash**");
  });

  it("shows an idle tool in monospace with runtime", () => {
    const line = renderDiscordStatusBar(
      snap({
        toolCalls: {
          total: 2,
          last: { name: "builtin-read", running: false, runtimeMs: 120 },
        },
      }),
      defaultCfg,
    );
    expect(line).toContain("🔧");
    expect(line).toContain("`builtin-read`");
    expect(line).toContain("120ms");
  });

  it("shows a paused (HITL-queued) tool in monospace with no runtime and not counted", () => {
    const line = renderDiscordStatusBar(
      snap({
        phase: "paused",
        toolCalls: {
          total: 0,
          last: { name: "builtin-exec", running: false },
        },
      }),
      defaultCfg,
    );
    expect(line).toContain("🔧");
    expect(line).toContain("`builtin-exec`");
    expect(line).not.toContain("ms");
  });

  it("extracts the argv executable for builtin-exec", () => {
    const line = renderDiscordStatusBar(
      snap({
        phase: "tool",
        toolCalls: {
          total: 1,
          last: { name: "builtin-exec", argPreview: "bash", running: true },
        },
      }),
      defaultCfg,
    );
    expect(line).toContain("**builtin-exec:bash**");
  });

  it("extracts the first string/argv entry for generic builtin tools", () => {
    const line = renderDiscordStatusBar(
      snap({
        phase: "tool",
        toolCalls: {
          total: 1,
          last: { name: "builtin-read", argPreview: "foo/bar.ts", running: true },
        },
      }),
      defaultCfg,
    );
    expect(line).toContain("**builtin-read:foo/bar.ts**");
  });

  it("omits the context section until usage data exists", () => {
    const line = renderDiscordStatusBar(snap(), defaultCfg);
    expect(line).not.toContain("🪟");
  });

  it("renders context as percent over the abbreviated window total", () => {
    const line = renderDiscordStatusBar(
      snap({ context: { currentTokens: 9_999, totalTokens: 100_000 } }),
      defaultCfg,
    );
    expect(line).toContain("🪟");
    expect(line).toContain("10.0%/100K");
  });

  it("abbreviates the window total at 1M", () => {
    const line = renderDiscordStatusBar(
      snap({ context: { currentTokens: 10_100, totalTokens: 1_000_000 } }),
      defaultCfg,
    );
    expect(line).toContain("1.0%/1M");
  });

  it("abbreviates the window total at 50M", () => {
    const line = renderDiscordStatusBar(
      snap({ context: { currentTokens: 1_050_000, totalTokens: 50_000_000 } }),
      defaultCfg,
    );
    expect(line).toContain("2.1%/50M");
  });

  it("formats percentage with one decimal", () => {
    const line = renderDiscordStatusBar(
      snap({ context: { currentTokens: 10_300, totalTokens: 100_000 } }),
      defaultCfg,
    );
    expect(line).toContain("10.3%/100K");
  });

  it("formats compactions with the compactions emoji", () => {
    const line = renderDiscordStatusBar(snap({ compactions: 4 }), defaultCfg);
    expect(line).toContain("🗑️");
    expect(line).toContain("4");
  });

  it("honors per-section config toggles to omit sections", () => {
    const cfg: ResolvedStatusBarConfig = {
      ...defaultCfg,
      statusEnabled: false,
      sequenceEnabled: false,
      contextWindowEnabled: false,
    };
    const line = renderDiscordStatusBar(
      snap({
        sequence: 217,
        context: { currentTokens: 12_000, totalTokens: 100_000 },
        toolCalls: { total: 1, last: { name: "builtin-read", running: false, runtimeMs: 5 } },
      }),
      cfg,
    );
    expect(line).not.toContain("⏳");
    expect(line).not.toContain("🔢");
    expect(line).not.toContain("🪟");
    expect(line).toContain("🔧");
    expect(line).toContain("🗑️");
  });

  it("joins sections with the fullwidth vertical bar character", () => {
    const line = renderDiscordStatusBar(
      snap({
        sequence: 217,
        context: { currentTokens: 8_200, totalTokens: 1_000_000 },
        compactions: 1,
      }),
      defaultCfg,
    );
    expect(line).toContain("｜");
  });
});
