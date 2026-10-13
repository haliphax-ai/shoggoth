import { describe, it } from "vitest";
import assert from "node:assert";
import {
  buildTimerTurnBanner,
  buildSessionMessageTurnBanner,
  buildWorkflowTurnBanner,
} from "../../src/messaging/oob-turn-banner";

describe("buildTimerTurnBanner", () => {
  it("renders the processing banner with blockquote, italics, and monospace id", () => {
    const b = buildTimerTurnBanner({ timerId: "t-1", message: "check the build" });
    assert.equal(b.processing, "> ⏰ Processing timer: *check the build* `t-1` …");
  });

  it("truncates a long message with an ellipsis", () => {
    const b = buildTimerTurnBanner({
      timerId: "t-1",
      message: "x".repeat(100),
      maxPromptChars: 10,
    });
    assert.equal(b.processing, "> ⏰ Processing timer: *xxxxxxxxxx…* `t-1` …");
  });

  it("terminal reflects the outcome emoji and verb", () => {
    const b = buildTimerTurnBanner({ timerId: "t-1", message: "m" });
    assert.equal(b.terminal("finished"), "> ⏰ ✅ Timer processed: `t-1`");
    assert.equal(b.terminal("aborted"), "> ⏰ 🛑 Timer aborted: `t-1`");
    assert.equal(b.terminal("failed"), "> ⏰ ❌ Timer failed: `t-1`");
  });
});

describe("buildSessionMessageTurnBanner", () => {
  it("renders processing + terminal banners", () => {
    const b = buildSessionMessageTurnBanner({ senderSessionId: "agent:developer:main" });
    assert.equal(b.processing, "> 🗨️ Processing incoming message from `agent:developer:main` …");
    assert.equal(b.terminal("finished"), "> 🗨️ ✅ Message processed from `agent:developer:main`");
    assert.equal(b.terminal("aborted"), "> 🗨️ 🛑 Message aborted from `agent:developer:main`");
    assert.equal(b.terminal("failed"), "> 🗨️ ❌ Message failed from `agent:developer:main`");
  });
});

describe("buildWorkflowTurnBanner", () => {
  it("renders processing + terminal with the title when present", () => {
    const b = buildWorkflowTurnBanner({ workflowId: "wf-9", title: "Release" });
    assert.equal(b.processing, "> ⚙️ Processing workflow notification from **Release** `wf-9` …");
    assert.equal(b.terminal("finished"), "> ⚙️ ✅ Workflow notification processed from `wf-9`");
  });

  it("omits the title segment when absent", () => {
    const b = buildWorkflowTurnBanner({ workflowId: "wf-9" });
    assert.equal(b.processing, "> ⚙️ Processing workflow notification `wf-9` …");
  });
});
