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

    it("keeps a banner in place when committed segments are multi-paragraph", () => {
      // A round's content may contain blank lines (the model narrates
      // "Raw spec:\n\n<paragraph>"), so a committed segment spans several
      // display blocks. The banner anchored after such a segment must land
      // after its LAST paragraph — never fall back to the tail.
      let committed = 0;
      const banners = createTurnBannerCollector({
        captureAnchor: () => anchor(committed),
      });
      committed = 1;
      banners.add("> trip");
      committed = 2;
      const segments = ["Raw spec:\n\nparagraph one", "recovery prose"];
      const display = "Raw spec:\n\nparagraph one\n\nrecovery prose";
      expect(banners.liveBody(display, { segments })).toBe(
        "Raw spec:\n\nparagraph one\n\n> trip\n\nrecovery prose",
      );
    });

    it("survives subsequent round commits after a multi-paragraph segment", () => {
      // Regression: every live push re-renders from scratch, so a lookup
      // failure would drag the banner to the tail as new rounds commit. With
      // segment-aware location the banner stays at its fire-time slot while
      // the turn keeps streaming.
      let committed = 1;
      const banners = createTurnBannerCollector({
        captureAnchor: () => anchor(committed),
      });
      banners.add("> mid-turn");
      const segments = ["Raw spec:\n\nparagraph one"];

      const afterOne = banners.liveBody("Raw spec:\n\nparagraph one", { segments });
      expect(afterOne).toBe("Raw spec:\n\nparagraph one\n\n> mid-turn");

      // Two more rounds commit after the banner fired: same anchor, new
      // display — the banner still trails only the first segment.
      segments.push("second round");
      const afterTwo = banners.liveBody("Raw spec:\n\nparagraph one\n\nsecond round", {
        segments,
      });
      expect(afterTwo).toBe("Raw spec:\n\nparagraph one\n\n> mid-turn\n\nsecond round");
      segments.push("third round");
      const afterThree = banners.liveBody(
        "Raw spec:\n\nparagraph one\n\nsecond round\n\nthird round",
        { segments },
      );
      expect(afterThree).toBe(
        "Raw spec:\n\nparagraph one\n\n> mid-turn\n\nsecond round\n\nthird round",
      );
    });

    it("still appends at the tail when a multi-paragraph segment is genuinely unlocatable", () => {
      const banners = createTurnBannerCollector({
        captureAnchor: () => anchor(1),
      });
      banners.add("> note");
      // Body was rewritten away from the segments (failover hop): the tail
      // fallback still applies.
      expect(
        banners.liveBody("Something else entirely", {
          segments: ["Raw spec:\n\nparagraph one"],
        }),
      ).toBe("Something else entirely\n\n> note");
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

    it("splices after the last paragraph of a multi-paragraph segment", () => {
      // Round-sized segments (content containing blank lines) span multiple
      // body blocks; the notice anchored after such a segment must land
      // after its final paragraph, not fall back to the tail.
      const banners = createTurnBannerCollector({
        captureAnchor: () => anchor(1),
      });
      banners.add("> note");
      const body = banners.terminalBody("Raw spec:\n\nparagraph one\n\nnext round", {
        segments: ["Raw spec:\n\nparagraph one", "next round"],
      });
      expect(body).toBe("Raw spec:\n\nparagraph one\n\n> note\n\nnext round");
    });

    it("interleaves a terminal notice in a body of all-multi-paragraph segments", () => {
      const banners = createTurnBannerCollector({
        captureAnchor: () => anchor(2),
      });
      banners.add("> note");
      const segments = ["P1a\n\nP1b", "P2a\n\nP2b", "P3"];
      const body = banners.terminalBody(segments.join("\n\n"), { segments });
      expect(body).toBe("P1a\n\nP1b\n\nP2a\n\nP2b\n\n> note\n\nP3");
    });

    it("anchors a round-boundary notice at the final segment count as an explicit trailing block", () => {
      // 3b semantics: a notice whose anchor equals the final segment count
      // fired after the last committed segment (a cancel banner after the
      // trip hop's round settled, with no further prose). It is a
      // CHRONOLOGICAL trailing notice and lands after the final segment —
      // distinct from the unresolvable-locate fallback below.
      const banners = createTurnBannerCollector({
        captureAnchor: () => anchor(2),
      });
      banners.add("> canceled");
      const body = banners.terminalBody("One\n\nTwo", { segments: ["One", "Two"] });
      expect(body).toBe("One\n\nTwo\n\n> canceled");
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
