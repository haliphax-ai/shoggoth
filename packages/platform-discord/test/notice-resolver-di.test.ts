import { describe, it } from "vitest";
import assert from "node:assert";

/**
 * Notices resolve through a resolver injected via `DiscordPlatformOptions`,
 * not a module-global registration. Verifies the DI wiring structurally.
 */
describe("notice resolver dependency injection", () => {
  it("platform.ts wires noticeResolver through DiscordPlatformOptions", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const platformSrc = fs.readFileSync(path.resolve(__dirname, "../src/platform.ts"), "utf-8");
    assert.ok(
      /readonly noticeResolver\?:\s*NoticeResolver/.test(platformSrc),
      "DiscordPlatformOptions should declare an optional noticeResolver",
    );
    assert.ok(
      /return opts\.noticeResolver \?\? daemonNotice/.test(platformSrc),
      "startDiscordPlatform should resolve notices from opts.noticeResolver (daemon fallback)",
    );
  });

  it("notices.ts exposes no global registration entry point", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const noticesSrc = fs.readFileSync(path.resolve(__dirname, "../src/notices.ts"), "utf-8");
    assert.ok(
      noticesSrc.includes("notice"),
      "notices.ts should keep hosting the shared notice helpers",
    );
    assert.ok(
      !/export function setNoticeResolver/.test(noticesSrc),
      "notices.ts must not export setNoticeResolver (module-global registration)",
    );
  });

  it("bootstrap.ts does not set a module-global notice resolver", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const bootstrapSrc = fs.readFileSync(path.resolve(__dirname, "../src/bootstrap.ts"), "utf-8");
    assert.ok(
      !/setNoticeResolver\(/.test(bootstrapSrc),
      "bootstrap.ts must not mutate a module-global notice resolver",
    );
  });
});
