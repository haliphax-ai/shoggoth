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
    expect(output.onText("R1\n\nR2\n\nR3")).toBe("R1\n\nR2 partial\n\nR3");
    expect(output.onText("R1\n\nR2\n\nR3 goes on")).toBe("R1\n\nR2 partial\n\nR3 goes on");
  });
});
