import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createTurnBannerCollector,
  postTurnSurfaceNotice,
  registerActiveTurnSurface,
  _resetActiveTurnSurfaces,
  type TurnNoticeAnchor,
} from "../../src/presentation/active-turn-surface";

const anchor = (committedProseSegments: number, toolCalls = 0): TurnNoticeAnchor => ({
  committedProseSegments,
  toolCalls,
});

describe("createTurnBannerCollector", () => {
  beforeEach(() => {
    _resetActiveTurnSurfaces();
  });

  describe("liveBody", () => {
    it("returns the display unchanged when no notices have been recorded", () => {
      const banners = createTurnBannerCollector({
        captureAnchor: () => anchor(0),
      });
      expect(banners.liveBody("Hello", { segments: ["Hello"] })).toBe("Hello");
    });

    it("splices a notice between the prose segments it fired between", () => {
      const banners = createTurnBannerCollector({
        captureAnchor: () => anchor(1),
      });
      banners.add("> note");
      expect(banners.liveBody("Hello\n\nWorld", { segments: ["Hello", "World"] })).toBe(
        "Hello\n\n> note\n\nWorld",
      );
    });

    it("places a pre-prose notice before the first segment", () => {
      const banners = createTurnBannerCollector({
        captureAnchor: () => anchor(0),
      });
      banners.add("> note");
      expect(banners.liveBody("Hello\n\nWorld", { segments: ["Hello", "World"] })).toBe(
        "> note\n\nHello\n\nWorld",
      );
    });

    it("keeps firing order for notices anchored at the same position", () => {
      const banners = createTurnBannerCollector({
        captureAnchor: () => anchor(1),
      });
      banners.add("> first");
      banners.add("> second");
      expect(banners.liveBody("Hello\n\nWorld", { segments: ["Hello", "World"] })).toBe(
        "Hello\n\n> first\n\n> second\n\nWorld",
      );
    });

    it("clamps an anchor beyond the committed segment count to the tail", () => {
      const banners = createTurnBannerCollector({
        captureAnchor: () => anchor(9),
      });
      banners.add("> note");
      expect(banners.liveBody("Hello\n\nWorld", { segments: ["Hello", "World"] })).toBe(
        "Hello\n\nWorld\n\n> note",
      );
    });

    it("places notices across a mid-stream turn at their committed slots", () => {
      let committed = 0;
      const banners = createTurnBannerCollector({
        captureAnchor: () => anchor(committed),
      });
      banners.add("> pre");
      committed = 1;
      banners.add("> after-one");
      committed = 2;
      banners.add("> after-two");
      // "Thr" is still streaming (not yet a committed segment), so the
      // last notice clamps to the tail of the display.
      expect(banners.liveBody("One\n\nTwo\n\nThr", { segments: ["One", "Two"] })).toBe(
        "> pre\n\nOne\n\n> after-one\n\nTwo\n\nThr\n\n> after-two",
      );
    });

    it("falls back to the tail-append when the live segment list is empty", () => {
      const banners = createTurnBannerCollector({
        captureAnchor: () => anchor(1),
      });
      banners.add("> note");
      expect(banners.liveBody("…", { segments: [] })).toBe("…\n\n> note");
    });

    it("falls back to the tail-append when a live segment cannot be located", () => {
      const banners = createTurnBannerCollector({
        captureAnchor: () => anchor(1),
      });
      banners.add("> note");
      // The display was rewritten away from the committed prose (e.g. a
      // mid-stream failover hop): nothing may be dropped or throw.
      expect(banners.liveBody("Something else entirely", { segments: ["Hello", "World"] })).toBe(
        "Something else entirely\n\n> note",
      );
    });

    it("tolerates a decoration glued onto the same block as a live segment", () => {
      const banners = createTurnBannerCollector({
        captureAnchor: () => anchor(1),
      });
      banners.add("> note");
      expect(banners.liveBody("**Rook:** Hello\n\nWorld", { segments: ["Hello", "World"] })).toBe(
        "**Rook:** Hello\n\n> note\n\nWorld",
      );
    });
  });

  describe("terminalBody", () => {
    it("splices a notice between the prose segments at its anchor", () => {
      const banners = createTurnBannerCollector({
        captureAnchor: () => anchor(1),
      });
      banners.add("> note");
      const body = banners.terminalBody("First segment\n\nSecond segment", {
        segments: ["First segment", "Second segment"],
      });
      expect(body).toBe("First segment\n\n> note\n\nSecond segment");
    });

    it("keeps firing order for notices anchored at the same position", () => {
      const banners = createTurnBannerCollector({
        captureAnchor: () => anchor(1),
      });
      banners.add("> first");
      banners.add("> second");
      const body = banners.terminalBody("First segment\n\nSecond segment", {
        segments: ["First segment", "Second segment"],
      });
      expect(body).toBe("First segment\n\n> first\n\n> second\n\nSecond segment");
    });

    it("places a pre-prose notice before the first segment", () => {
      const banners = createTurnBannerCollector({
        captureAnchor: () => anchor(0),
      });
      banners.add("> note");
      const body = banners.terminalBody("First segment\n\nSecond segment", {
        segments: ["First segment", "Second segment"],
      });
      expect(body).toBe("> note\n\nFirst segment\n\nSecond segment");
    });

    it("falls back to the end-of-body block when the anchor exceeds the segment count", () => {
      const banners = createTurnBannerCollector({
        captureAnchor: () => anchor(9),
      });
      banners.add("> note");
      const body = banners.terminalBody("First segment\n\nSecond segment", {
        segments: ["First segment", "Second segment"],
      });
      expect(body).toBe("First segment\n\nSecond segment\n\n> note");
    });

    it("falls back to the end-of-body block when there are no prose segments", () => {
      const banners = createTurnBannerCollector({
        captureAnchor: () => anchor(1),
      });
      banners.add("> note");
      const body = banners.terminalBody("_Turn failed_", { segments: [] });
      expect(body).toBe("_Turn failed_\n\n> note");
    });

    it("falls back to the end-of-body block when segments cannot be located in the body", () => {
      const banners = createTurnBannerCollector({
        captureAnchor: () => anchor(1),
      });
      banners.add("> note");
      // The body was rewritten (e.g. a failover hop) so the segment texts are
      // gone; nothing may be dropped, the notes trail at the end.
      const body = banners.terminalBody("Something else entirely", {
        segments: ["First segment", "Second segment"],
      });
      expect(body).toBe("Something else entirely\n\n> note");
    });

    it("splices between segments when thinking quotes interleave them", () => {
      const banners = createTurnBannerCollector({
        captureAnchor: () => anchor(1),
      });
      banners.add("> note");
      const body = banners.terminalBody("A\n\n> 💭 think\n\nB", {
        segments: ["A", "B"],
      });
      expect(body).toBe("A\n\n> note\n\n> 💭 think\n\nB");
    });

    it("tolerates a decoration glued onto the same block as the first segment", () => {
      const banners = createTurnBannerCollector({
        captureAnchor: () => anchor(1),
      });
      banners.add("> note");
      const body = banners.terminalBody("**⚜️ Rook:**\nA\n\nB", {
        segments: ["A", "B"],
      });
      expect(body).toBe("**⚜️ Rook:**\nA\n\n> note\n\nB");
    });

    it("returns the body unchanged when no notices have been recorded", () => {
      const banners = createTurnBannerCollector({
        captureAnchor: () => anchor(0),
      });
      expect(banners.terminalBody("First\n\nSecond", { segments: ["First", "Second"] })).toBe(
        "First\n\nSecond",
      );
    });
  });

  describe("registry", () => {
    it("captures the anchor from captureAnchor at fire time", () => {
      let committed = 0;
      const banners = createTurnBannerCollector({
        captureAnchor: () => anchor(committed),
      });
      registerActiveTurnSurface("s1", banners);
      committed = 1;
      expect(postTurnSurfaceNotice("s1", "> note")).toBe(true);
      expect(banners.terminalBody("A\n\nB", { segments: ["A", "B"] })).toBe("A\n\n> note\n\nB");
    });

    it("wraps an options object into a collector at registration", () => {
      const notices: string[] = [];
      const surface = registerActiveTurnSurface("s2", {
        captureAnchor: () => anchor(0),
        onNotice: (notice) => {
          notices.push(notice);
        },
      });
      expect(postTurnSurfaceNotice("s2", "> hello")).toBe(true);
      expect(notices).toEqual(["> hello"]);
      surface.unregister();
      expect(postTurnSurfaceNotice("s2", "> late")).toBe(false);
    });

    it("returns false when no surface is registered", () => {
      expect(postTurnSurfaceNotice("nope", "> note")).toBe(false);
    });

    it("records the notice even when onNotice is not provided", () => {
      const banners = createTurnBannerCollector({
        captureAnchor: () => anchor(1),
      });
      registerActiveTurnSurface("s3", banners);
      expect(postTurnSurfaceNotice("s3", "> note")).toBe(true);
      expect(banners.terminalBody("A\n\nB", { segments: ["A", "B"] })).toBe("A\n\n> note\n\nB");
    });

    it("invokes onNotice when a notice is recorded", () => {
      const onNotice = vi.fn();
      const banners = createTurnBannerCollector({
        captureAnchor: () => anchor(0),
        onNotice,
      });
      registerActiveTurnSurface("s4", banners);
      postTurnSurfaceNotice("s4", "> note");
      expect(onNotice).toHaveBeenCalledWith("> note");
    });
  });
});
