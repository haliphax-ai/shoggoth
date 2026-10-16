import { describe, expect, it } from "vitest";
import { renderThinkingBlockquote } from "../src/thinking-quote";

describe("renderThinkingBlockquote", () => {
  it("marks only the first line with the emoji and keeps continuation lines bare", () => {
    expect(renderThinkingBlockquote("Reasoning\ncontinues\nfurther")).toBe(
      "> 💭 Reasoning\n> continues\n> further",
    );
  });

  it("renders a single-line block as one quoted marker line", () => {
    expect(renderThinkingBlockquote("Just a thought")).toBe("> 💭 Just a thought");
  });
});
