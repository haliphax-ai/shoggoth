import { describe, expect, it } from "vitest";
import { createThinkingOutput } from "../../src/messaging/thinking-output";

describe("createThinkingOutput", () => {
  it("slipstreams thinking between prose deltas with emoji blockquotes", () => {
    const output = createThinkingOutput();
    expect(output.onText("Before ")).toBe("Before ");
    expect(output.onThinking("Reasoning\ncontinues")).toBe(
      "Before \n\n> 💭 Reasoning\n> 💭 continues",
    );
    expect(output.onText("Before after")).toBe(
      "Before \n\n> 💭 Reasoning\n> 💭 continues\n\nafter",
    );
    expect(output.render("Before after!")).toBe(
      "Before \n\n> 💭 Reasoning\n> 💭 continues\n\nafter!",
    );
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
});
