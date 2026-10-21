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
      expect(banners.liveBody("Hello")).toBe("Hello");
    });

    it("appends recorded notices as one trailing block", () => {
      const banners = createTurnBannerCollector({
        captureAnchor: () => anchor(0),
      });
      banners.add("> first");
      banners.add("> second");
      expect(banners.liveBody("Hello")).toBe("Hello\n\n> first\n\n> second");
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

    it("mirrors legacy sink registration for producers", () => {
      const notices: string[] = [];
      const surface = registerActiveTurnSurface("s2", (notice) => {
        notices.push(notice);
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
