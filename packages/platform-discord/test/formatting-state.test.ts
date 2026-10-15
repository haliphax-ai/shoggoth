import { describe, it } from "vitest";
import assert from "node:assert";
import {
  appendSyntheticClose,
  computeChunkClose,
  computeOpenFormatting,
} from "../src/formatting-state";

describe("computeOpenFormatting", () => {
  it("reports closed state for plain text", () => {
    assert.deepStrictEqual(computeOpenFormatting("hello world"), {
      openFence: "",
      openInline: [],
    });
  });

  it("reports closed state for balanced inline markers", () => {
    assert.deepStrictEqual(computeOpenFormatting("this is *italic* and **bold** text"), {
      openFence: "",
      openInline: [],
    });
  });

  it("reports an unclosed inline marker", () => {
    assert.deepStrictEqual(computeOpenFormatting("this is *italic that isn't finished"), {
      openFence: "",
      openInline: ["*"],
    });
  });

  it("reports an unclosed fenced block with its language tag", () => {
    const state = computeOpenFormatting("intro\n```ts\nconst x = 1;\n");
    assert.strictEqual(state.openFence, "```ts");
    assert.deepStrictEqual(state.openInline, []);
  });

  it("reports closed state once the fence closes", () => {
    const state = computeOpenFormatting("```ts\nconst x = 1;\n```\ndone");
    assert.strictEqual(state.openFence, "");
  });

  it("ignores inline markers inside a fenced block", () => {
    const state = computeOpenFormatting("```\n*not italic**still not\n");
    assert.strictEqual(state.openFence, "```");
    assert.deepStrictEqual(state.openInline, []);
  });

  it("carries prior state across chunks", () => {
    const first = computeOpenFormatting("start **bold");
    assert.deepStrictEqual(first.openInline, ["**"]);
    // The reopened marker + its completion close the pair in the next chunk.
    const second = computeOpenFormatting("** and done", first);
    assert.deepStrictEqual(second.openInline, []);
  });

  it("prefers ** over * when counting", () => {
    const state = computeOpenFormatting("a **bold** b *italic");
    assert.deepStrictEqual(state.openInline, ["*"]);
  });

  it("ignores markers inside inline code spans", () => {
    const state = computeOpenFormatting("run `npm i *` now");
    assert.deepStrictEqual(state.openInline, []);
  });

  // Single "_" follows Discord's asymmetric word-boundary rule.
  it("tracks a wrapped single underscore as balanced (T1)", () => {
    const state = computeOpenFormatting("pre _wrapped italic_ post");
    assert.deepStrictEqual(state.openInline, []);
  });

  it("tracks a wrapped single underscore at message start as balanced (T2)", () => {
    const state = computeOpenFormatting("_wrapped italic_ at the very beginning");
    assert.deepStrictEqual(state.openInline, []);
  });

  it("reports an unclosed boundary underscore after a space (T3)", () => {
    const state = computeOpenFormatting("pre _unclosed at beginning, no closing tail");
    assert.deepStrictEqual(state.openInline, ["_"]);
  });

  it("ignores a lone closer-side underscore (T4/T6)", () => {
    // "word_" — a single _ preceded by a word char with no opener opens nothing.
    const state = computeOpenFormatting("pre unopened at end only_ tail");
    assert.deepStrictEqual(state.openInline, []);
    assert.strictEqual(
      computeOpenFormatting("message ends with an unclosed underscore at end of text_").openInline
        .length,
      0,
    );
  });

  it("ignores intra-word single underscores, even an odd count (T5)", () => {
    // snake_case_name has two _s (even) but snake_case has one (odd); neither formats.
    assert.deepStrictEqual(
      computeOpenFormatting("mid_word_underscore_inside_text here").openInline,
      [],
    );
    assert.deepStrictEqual(computeOpenFormatting("the snake_case token here").openInline, []);
  });

  it("reports an unclosed boundary underscore at message start (T7)", () => {
    const state = computeOpenFormatting("_underscore at the very beginning, unclosed here");
    assert.deepStrictEqual(state.openInline, ["_"]);
  });

  it("closes a boundary underscore across lines", () => {
    const state = computeOpenFormatting("_italic started here\nand closed here_ tail");
    assert.deepStrictEqual(state.openInline, []);
  });

  it("does not let an intra-word _ close an open boundary _", () => {
    const state = computeOpenFormatting("_start and snake_case token");
    assert.deepStrictEqual(state.openInline, ["_"]);
  });
});

describe("computeChunkClose", () => {
  it("returns an empty suffix when everything is closed", () => {
    const { suffix } = computeChunkClose("all *closed* here");
    assert.strictEqual(suffix, "");
  });

  it("closes inline markers in reverse open order", () => {
    const { suffix } = computeChunkClose("a *i and __u");
    // Open order follows INLINE_MARKERS: ["__", "*"]; reverse close: "*" then "__".
    assert.strictEqual(suffix, "*__");
  });

  it("closes an open fence on its own line", () => {
    const { suffix } = computeChunkClose("code:\n```js\nlet x;");
    assert.strictEqual(suffix, "\n```");
  });

  it("closes an open fence without a trailing newline", () => {
    const { suffix } = computeChunkClose("```js\nlet x;");
    assert.strictEqual(suffix, "\n```");
  });
});

describe("appendSyntheticClose", () => {
  it("returns text unchanged when no markers are open", () => {
    assert.strictEqual(appendSyntheticClose("nothing to close"), "nothing to close");
  });

  it("closes an unclosed italic marker", () => {
    assert.strictEqual(appendSyntheticClose("*italic unfinished"), "*italic unfinished*");
  });

  it("closes multiple unclosed markers", () => {
    assert.strictEqual(appendSyntheticClose("*a **b"), "*a **b***");
  });

  it("closes an unclosed fenced block", () => {
    assert.strictEqual(appendSyntheticClose("```\ncode"), "```\ncode\n```");
  });

  it("keeps the language tag intact when closing a fence", () => {
    assert.strictEqual(appendSyntheticClose("```ts\nlet x"), "```ts\nlet x\n```");
  });

  it("does not append inline closes while inside a fence", () => {
    // Markers inside a fence are literal text; only the fence close is needed.
    assert.strictEqual(appendSyntheticClose("```\n*code* **still"), "```\n*code* **still\n```");
  });

  it("is idempotent", () => {
    const once = appendSyntheticClose("*unfinished");
    assert.strictEqual(appendSyntheticClose(once), once);
  });

  it("closes an unclosed boundary single underscore", () => {
    assert.strictEqual(
      appendSyntheticClose("pre _unclosed at beginning"),
      "pre _unclosed at beginning_",
    );
  });

  it("leaves snake_case prose untouched", () => {
    assert.strictEqual(appendSyntheticClose("the snake_case token"), "the snake_case token");
    assert.strictEqual(
      appendSyntheticClose("mid_word_underscore_inside"),
      "mid_word_underscore_inside",
    );
  });

  it("leaves a lone closer-side underscore untouched", () => {
    assert.strictEqual(appendSyntheticClose("ends with word_"), "ends with word_");
  });
});
