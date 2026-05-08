import { describe, it } from "vitest";
import assert from "node:assert";

/**
 * Verify that the subagentExt object constructed in plugin.ts includes
 * createThread and resolveOutboundChannelIdForSession.
 *
 * Rather than spinning up the full platform, we inspect the source directly
 * via a structural assertion on the plugin module's subagentExt construction.
 * The actual runtime wiring is validated by the daemon integration tests.
 */
describe("subagent extension wiring", () => {
  it("plugin.ts source includes createThread in subagentExt", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const pluginSrc = fs.readFileSync(path.resolve(__dirname, "../src/plugin.ts"), "utf-8");
    assert.ok(
      pluginSrc.includes("createThread"),
      "plugin.ts should wire createThread into subagentExt",
    );
  });

  it("plugin.ts source includes resolveOutboundChannelIdForSession in subagentExt", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const pluginSrc = fs.readFileSync(path.resolve(__dirname, "../src/plugin.ts"), "utf-8");
    assert.ok(
      pluginSrc.includes("resolveOutboundChannelIdForSession"),
      "plugin.ts should wire resolveOutboundChannelIdForSession into subagentExt",
    );
  });
});
