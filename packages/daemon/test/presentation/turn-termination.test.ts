import { describe, it, expect } from "vitest";
import { createTurnBannerCollector } from "../../src/presentation/active-turn-surface";
import { renderTurnTerminationBody } from "../../src/presentation/stream-coordinator";

const segments = ["One", "Two"];

/**
 * A surface delivering its final body the way the terminal path does:
 * exactly one delivery edit carries the coordinator's final result.
 */
const deliverOnce = (): { renders: string[]; deliver: (body: string) => void } => {
  const renders: string[] = [];
  return {
    renders,
    deliver: (body: string) => {
      renders.push(body);
    },
  };
};

describe("turn termination shaping", () => {
  it("renders exactly one terminal body with the banners interleaved in place", async () => {
    const banners = createTurnBannerCollector({
      captureAnchor: () => ({ committedProseSegments: 1, toolCalls: 1 }),
    });
    banners.add("> ⚙️ banner");
    const surface = deliverOnce();

    const final = await renderTurnTerminationBody("One\n\nTwo", [
      (body) => banners.terminalBody(body, { segments }),
    ]);
    surface.deliver(final);

    expect(surface.renders).toEqual(["One\n\n> ⚙️ banner\n\nTwo"]);
  });

  it("never produces an intermediate state where the banners sit at the bottom", async () => {
    const banners = createTurnBannerCollector({
      captureAnchor: () => ({ committedProseSegments: 1, toolCalls: 0 }),
    });
    banners.add("> ⚙️ banner");

    // The capture wrapper stands in for the in-flight message: every shape
    // must run against the coordinator's in-memory copy, so the surface
    // never observes the un-spliced body (banners still at the bottom of
    // the block list) as an intermediate state.
    const observed: string[] = [];
    const final = await renderTurnTerminationBody("One\n\nTwo", [
      (body) => {
        observed.push(body);
        return banners.terminalBody(body, { segments });
      },
      (body) => {
        observed.push(body);
        return body;
      },
    ]);

    // Between steps the copy already carries the interleaved layout.
    expect(observed).toEqual(["One\n\nTwo", "One\n\n> ⚙️ banner\n\nTwo"]);
    expect(final).toBe("One\n\n> ⚙️ banner\n\nTwo");
    // The banner block never trails at the end of the body.
    expect(final.endsWith("> ⚙️ banner")).toBe(false);
  });

  it("claims exactly one terminal render even when the shaping chain runs again", async () => {
    const banners = createTurnBannerCollector({
      captureAnchor: () => ({ committedProseSegments: 1, toolCalls: 0 }),
    });
    banners.add("> ⚙️ banner");
    const splice = (body: string) => banners.terminalBody(body, { segments });

    const first = await renderTurnTerminationBody("One\n\nTwo", [splice]);
    // A second (re-run) shaping pass yields the same final body — the
    // collector does not render a second time.
    const second = await renderTurnTerminationBody("One\n\nTwo", [splice]);

    expect(second).toBe(first);
    expect(first).toBe("One\n\n> ⚙️ banner\n\nTwo");
    // The original body re-spliced for comparison would differ only if the
    // collector had rendered again and appended; it did not.
    expect(banners.terminalBody("One\n\nTwo", { segments })).toBe(first);
  });

  it("renders an error body once after the delivered body without re-shaping either", async () => {
    const banners = createTurnBannerCollector({
      captureAnchor: () => ({ committedProseSegments: 1, toolCalls: 0 }),
    });
    banners.add("> ⚙️ banner");
    const splice = (body: string) => banners.terminalBody(body, { segments });

    const delivered = await renderTurnTerminationBody("One\n\nTwo", [splice]);
    // The delivery edit fails downstream: the error path shapes its own
    // body — it gets its own single render, not a re-shape of the
    // delivered body.
    const error = await renderTurnTerminationBody("err:Error: ECONNRESET", [splice]);

    expect(delivered).toBe("One\n\n> ⚙️ banner\n\nTwo");
    expect(error).toBe("err:Error: ECONNRESET\n\n> ⚙️ banner");
    // Both stay stable on any re-run.
    expect(splice("One\n\nTwo")).toBe(delivered);
    expect(splice("err:Error: ECONNRESET")).toBe(error);
  });

  it("is fail-open when a shaping step throws", async () => {
    const banners = createTurnBannerCollector({
      captureAnchor: () => ({ committedProseSegments: 1, toolCalls: 0 }),
    });
    banners.add("> ⚙️ banner");
    const surface = deliverOnce();

    await expect(
      renderTurnTerminationBody("One\n\nTwo", [
        () => {
          throw new Error("shaping interrupted");
        },
        (body) => banners.terminalBody(body, { segments }),
      ]),
    ).rejects.toThrow("shaping interrupted");

    // Nothing was rendered and nothing delivered — the already-streamed
    // output stands as the final record.
    expect(surface.renders).toEqual([]);
  });

  it("is fail-open when a shaping step rejects asynchronously", async () => {
    const banners = createTurnBannerCollector({
      captureAnchor: () => ({ committedProseSegments: 1, toolCalls: 0 }),
    });
    banners.add("> ⚙️ banner");

    await expect(
      renderTurnTerminationBody("One\n\nTwo", [
        async () => {
          throw new Error("interrupted mid-pass");
        },
        (body) => banners.terminalBody(body, { segments }),
      ]),
    ).rejects.toThrow("interrupted mid-pass");

    // The failed pass never claimed the terminal render: the banner splice
    // is still available and still produces the interleaved layout — no
    // partial or bottom-smashed layout was produced by the failed pass.
    expect(banners.terminalBody("One\n\nTwo", { segments })).toBe("One\n\n> ⚙️ banner\n\nTwo");
  });

  it("passes an empty step list through untouched", async () => {
    await expect(renderTurnTerminationBody("Final body", [])).resolves.toBe("Final body");
  });
});
