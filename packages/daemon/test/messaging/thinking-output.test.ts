import { describe, expect, it } from "vitest";
import { createThinkingOutput } from "../../src/messaging/thinking-output";

describe("createThinkingOutput", () => {
  it("slipstreams thinking between prose deltas with an emoji on the block's first line", () => {
    const output = createThinkingOutput();
    expect(output.onText("Before ")).toBe("Before ");
    expect(output.onThinking("Reasoning\ncontinues")).toBe(
      "Before \n\n> 💭 Reasoning\n> continues",
    );
    expect(output.onText("Before after")).toBe("Before \n\n> 💭 Reasoning\n> continues\n\nafter");
    expect(output.render("Before after!")).toBe("Before \n\n> 💭 Reasoning\n> continues\n\nafter!");
  });

  it("preserves the final prose if it was not streamed", () => {
    const output = createThinkingOutput();
    output.onThinking("Reasoning");
    expect(output.render("Final answer")).toBe("> 💭 Reasoning\n\nFinal answer");
  });

  it("does not duplicate cumulative deltas", () => {
    const output = createThinkingOutput();
    output.onThinking("Think");
    expect(output.onThinking("Thinking")).toBe("> 💭 Thinking");
  });

  it("does not re-push accumulated history when the stream restarts mid-turn", () => {
    // A tool round whose streamed tail differs from its final content (trim,
    // failover hop, steering-injected round) makes the next round's display
    // (priorRounds + new accumulation) diverge from the previous snapshot.
    // Only the genuinely new tail may enter the parts — never the shared
    // history, which used to duplicate every earlier segment in the render.
    const output = createThinkingOutput();
    expect(output.onText("R1")).toBe("R1");
    expect(output.onText("R1\n\nR2 partial")).toBe("R1\n\nR2 partial");
    // The superseded tail ("R2 partial") is replaced by the restarted
    // stream's content — never duplicated, and never split by a formatting
    // blank line at the mid-word divergence point.
    expect(output.onText("R1\n\nR2\n\nR3")).toBe("R1\n\nR2\n\nR3");
    expect(output.onText("R1\n\nR2\n\nR3 goes on")).toBe("R1\n\nR2\n\nR3 goes on");
  });

  it("never inserts a blank line mid-word when the prose stream diverges", () => {
    const output = createThinkingOutput();
    expect(output.onText("Bad attempts got zero feedb")).toBe("Bad attempts got zero feedb");
    expect(output.onText("Bad attempts got zero feedACK")).toBe("Bad attempts got zero feedACK");
    // The delivered body maps parts onto the final prose: a mid-word part
    // boundary must not become a blank-line cut there, and the decoration
    // around the prose (identity prefix, model-tag footer) survives intact.
    expect(output.render("**Rook:**\nBad attempts got zero feedACK\n· m: test")).toBe(
      "**Rook:**\nBad attempts got zero feedACK\n· m: test",
    );
  });

  it("keeps a thinking block contiguous when the reasoning stream restarts mid-word", () => {
    const output = createThinkingOutput();
    expect(output.onThinking("Consider this")).toBe("> 💭 Consider this");
    // A restarted reasoning tail must merge into its block — no blank line
    // and no spurious 💭 marker at the mid-word divergence point.
    expect(output.onThinking("Consider that")).toBe("> 💭 Consider that");
  });

  it("delivers the clean final prose when the stream diverged from the final content", () => {
    const output = createThinkingOutput();
    output.onText("Streamed tail");
    output.onText("Streamed replacement tail"); // mid-stream failover hop
    expect(output.render("**Rook:**\nClean final prose")).toBe("**Rook:**\nClean final prose");
  });
});
