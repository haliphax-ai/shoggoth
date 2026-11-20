import { describe, expect, it } from "vitest";
import { createThinkingOutput } from "../../src/messaging/thinking-output";

describe("createThinkingOutput", () => {
  it("slipstreams thinking between prose deltas with an emoji on the block's first line", () => {
    const output = createThinkingOutput();
    expect(output.onText({ accumulated: "Before ", round: 0 })).toBe("Before ");
    expect(output.onThinking({ accumulated: "Reasoning\ncontinues", round: 0 })).toBe(
      "Before \n\n> 💭 Reasoning\n> continues",
    );
    expect(output.onText({ accumulated: "Before after", round: 0 })).toBe(
      "Before \n\n> 💭 Reasoning\n> continues\n\nafter",
    );
    expect(output.render("Before after!")).toBe("Before \n\n> 💭 Reasoning\n> continues\n\nafter!");
  });

  it("preserves the final prose if it was not streamed", () => {
    const output = createThinkingOutput();
    output.onThinking({ accumulated: "Reasoning", round: 0 });
    expect(output.render("Final answer")).toBe("> 💭 Reasoning\n\nFinal answer");
  });

  it("does not duplicate cumulative deltas", () => {
    const output = createThinkingOutput();
    output.onThinking({ accumulated: "Think", round: 0 });
    expect(output.onThinking({ accumulated: "Thinking", round: 0 })).toBe("> 💭 Thinking");
  });

  it("delivers round separators at round boundaries, never mid-round", () => {
    // The producer streams each round's content WITHOUT a separator and
    // settles the round via endRound; the separator belongs to the boundary
    // and must appear with the next round's first delta — a round boundary
    // must never render as a spurious divergence or a trailing blank line.
    const output = createThinkingOutput();
    expect(output.onText({ accumulated: "R1", round: 0 })).toBe("R1");
    expect(output.endRound({ round: 0, content: "R1" })).toBe("R1");
    expect(output.onText({ accumulated: "R2 sta", round: 1 })).toBe("R1\n\nR2 sta");
    // The final content extends the streamed tail: append, no new block.
    expect(output.endRound({ round: 1, content: "R2 starts" })).toBe("R1\n\nR2 starts");
    expect(output.onText({ accumulated: "R3", round: 2 })).toBe("R1\n\nR2 starts\n\nR3");
    expect(output.endRound({ round: 2, content: "R3" })).toBe("R1\n\nR2 starts\n\nR3");
  });

  it("replaces a round's drifted streamed tail at the round boundary", () => {
    // A round whose streamed tail differs from its final content (trim,
    // failover hop, steering-injected round) is reconciled by endRound —
    // the superseded tail shows live, then the authoritative content lands
    // exactly once, before the next round's separator.
    const output = createThinkingOutput();
    output.onText({ accumulated: "R1", round: 0 });
    output.endRound({ round: 0, content: "R1" });
    expect(output.onText({ accumulated: "Done partial", round: 1 })).toBe("R1\n\nDone partial");
    expect(output.endRound({ round: 1, content: "Done." })).toBe("R1\n\nDone.");
    expect(output.onText({ accumulated: "All green.", round: 2 })).toBe(
      "R1\n\nDone.\n\nAll green.",
    );
  });

  it("keeps a round's streamed prose visible when a fresh stream re-fires empty", () => {
    // A provider retry / failover hop can re-fire the round's stream with a
    // fresh accumulation. An empty remainder must NEVER splice the display
    // to zero — the superseded text stays until a non-empty replacement.
    const output = createThinkingOutput();
    expect(output.onText({ accumulated: "Streamed tail", round: 0 })).toBe("Streamed tail");
    expect(output.onText({ accumulated: "", round: 0 })).toBe("Streamed tail");
    expect(output.onText({ accumulated: "Streamed replacement tail", round: 0 })).toBe(
      "Streamed replacement tail",
    );
  });

  it("keeps a thinking block visible when a fresh reasoning stream re-fires empty", () => {
    const output = createThinkingOutput();
    expect(output.onThinking({ accumulated: "Consider this", round: 0 })).toBe(
      "> 💭 Consider this",
    );
    expect(output.onThinking({ accumulated: "", round: 0 })).toBe("> 💭 Consider this");
    expect(output.onThinking({ accumulated: "Consider that", round: 0 })).toBe(
      "> 💭 Consider that",
    );
  });

  it("opens a new quote block for a re-emitted prefix continuation at a round boundary", () => {
    // Many providers re-emit the prior reasoning at the start of a new round
    // (context quoting, not one continuous thought). The shared prefix is
    // already displayed — the new round renders only its NEW text in its own
    // 💭 block at its arrival position; the earlier block is never extended,
    // reordered, or re-emitted.
    const output = createThinkingOutput();
    output.onText({ accumulated: "Before ", round: 0 });
    output.onThinking({ accumulated: "Reasoning so far", round: 0 });
    output.endRound({ round: 0, content: "Before " });
    expect(output.onText({ accumulated: "after", round: 1 })).toBe(
      "Before \n\n> 💭 Reasoning so far\n\nafter",
    );
    expect(output.onThinking({ accumulated: "Reasoning so far and more", round: 1 })).toBe(
      "Before \n\n> 💭 Reasoning so far\n\nafter\n\n> 💭 and more",
    );
    expect(output.render().split("💭").length - 1).toBe(2);
  });

  it("strips a genuine re-emission at a round boundary and shows only the new tail", () => {
    // A provider that re-emits the prior reasoning VERBATIM at the start of
    // a new round (context quoting) must not double it: the re-emission is
    // stripped and only the genuinely new tail opens the round's own 💭
    // block, at its arrival position.
    const output = createThinkingOutput();
    output.onText({ accumulated: "Before ", round: 0 });
    output.onThinking({ accumulated: "Let me check the config", round: 0 });
    output.endRound({ round: 0, content: "Before " });
    expect(output.onText({ accumulated: "after", round: 1 })).toBe(
      "Before \n\n> 💭 Let me check the config\n\nafter",
    );
    // The verbatim re-emit renders nothing new…
    expect(output.onThinking({ accumulated: "Let me check the config", round: 1 })).toBe(
      "Before \n\n> 💭 Let me check the config\n\nafter",
    );
    // …and the moment it continues past the base, only the new tail opens
    // the round's own block.
    expect(output.onThinking({ accumulated: "Let me check the config carefully", round: 1 })).toBe(
      "Before \n\n> 💭 Let me check the config\n\nafter\n\n> 💭 carefully",
    );
    expect(output.render().split("💭").length - 1).toBe(2);
  });

  it("never strips a coincidental shared opening from a new round's reasoning", () => {
    // Rounds that merely OPEN alike ("Let me …") share a prefix by
    // coincidence — the new round's opening is its own reasoning and must
    // display in full, never eaten down to the divergence point.
    const output = createThinkingOutput();
    output.onThinking({ accumulated: "Let me look at the slash commands file", round: 0 });
    output.endRound({ round: 0, content: "" });
    output.onText({ accumulated: "Checking.", round: 1 });
    // A re-emit still streaming in (a prefix of the base) holds silently…
    expect(output.onThinking({ accumulated: "Let me ", round: 1 })).toBe(
      "> 💭 Let me look at the slash commands file\n\nChecking.",
    );
    // …but the moment it veers off the base, the whole accumulated text is
    // new reasoning — displayed verbatim in its own block, glued to nothing.
    expect(output.onThinking({ accumulated: "Let me fix the tool calls", round: 1 })).toBe(
      "> 💭 Let me look at the slash commands file\n\nChecking.\n\n> 💭 Let me fix the tool calls",
    );
    expect(output.render()).toContain("💭 Let me fix the tool calls");
    expect(output.render()).toContain("slash commands file\n\nChecking.");
  });

  it("never splices a partially re-emitted round onto an earlier round's block", () => {
    // A round that streams a strict PREFIX of the earlier reasoning and
    // then veers must not cut the earlier block or glue text mid-word:
    // the earlier block stays intact and the veering text lands whole in
    // its own block at its arrival position.
    const output = createThinkingOutput();
    output.onThinking({ accumulated: "The issue says tests fail", round: 0 });
    output.endRound({ round: 0, content: "" });
    output.onText({ accumulated: "Looking around.", round: 1 });
    expect(output.onThinking({ accumulated: "The iss", round: 1 })).toBe(
      "> 💭 The issue says tests fail\n\nLooking around.",
    );
    expect(
      output.onThinking({ accumulated: "The isslook at how the parser is invoked", round: 1 }),
    ).toBe(
      "> 💭 The issue says tests fail\n\nLooking around.\n\n> 💭 The isslook at how the parser is invoked",
    );
    // No mid-word seam anywhere: the earlier block still ends with "fail",
    // and nothing was duplicated across the round boundary.
    expect(output.render()).toContain("tests fail\n\nLooking around.");
    expect(output.render().split("The iss").length - 1).toBe(2);
  });

  it("renders thinking blocks at their arrival position across interleaved rounds", () => {
    // Round-0 reasoning renders after round-0 prose and round-1 reasoning
    // after round-1 prose: every 💭 block sits where its text arrived.
    const output = createThinkingOutput();
    output.onText({ accumulated: "First an update.", round: 0 });
    output.onThinking({ accumulated: "Noticing a first thing", round: 0 });
    output.endRound({ round: 0, content: "First an update." });
    output.onText({ accumulated: "Then the fix.", round: 1 });
    expect(output.onThinking({ accumulated: "Second thought here", round: 1 })).toBe(
      "First an update.\n\n> 💭 Noticing a first thing\n\nThen the fix.\n\n> 💭 Second thought here",
    );
  });

  it("opens a fresh quote block when reasoning restarts at a round boundary", () => {
    const output = createThinkingOutput();
    output.onText({ accumulated: "Before ", round: 0 });
    output.onThinking({ accumulated: "First round thought", round: 0 });
    output.endRound({ round: 0, content: "Before " });
    output.onText({ accumulated: "after", round: 1 });
    // Unrelated reasoning in a new round keeps the earlier block untouched
    // and lands in its own 💭 block at its arrival position.
    expect(output.onThinking({ accumulated: "An entirely new thought", round: 1 })).toBe(
      "Before \n\n> 💭 First round thought\n\nafter\n\n> 💭 An entirely new thought",
    );
  });

  it("never inserts a blank line mid-word when the prose stream diverges", () => {
    const output = createThinkingOutput();
    expect(output.onText({ accumulated: "Bad attempts got zero feedb", round: 0 })).toBe(
      "Bad attempts got zero feedb",
    );
    expect(output.onText({ accumulated: "Bad attempts got zero feedACK", round: 0 })).toBe(
      "Bad attempts got zero feedACK",
    );
    // The delivered body maps parts onto the final prose: a mid-word part
    // boundary must not become a blank-line cut there, and the decoration
    // around the prose (identity prefix, model-tag footer) survives intact.
    expect(output.render("**Rook:**\nBad attempts got zero feedACK\n· m: test")).toBe(
      "**Rook:**\nBad attempts got zero feedACK\n· m: test",
    );
  });

  it("keeps a thinking block contiguous when the reasoning stream restarts mid-word", () => {
    const output = createThinkingOutput();
    expect(output.onThinking({ accumulated: "Consider this", round: 0 })).toBe(
      "> 💭 Consider this",
    );
    // A restarted reasoning tail must merge into its block — no blank line
    // and no spurious 💭 marker at the mid-word divergence point.
    expect(output.onThinking({ accumulated: "Consider that", round: 0 })).toBe(
      "> 💭 Consider that",
    );
  });

  it("strips leading blank lines and padding from quote blocks", () => {
    const output = createThinkingOutput();
    // A leading newline would render as an empty line right after the 💭
    // marker; a leading space as a doubled space.
    expect(output.onThinking({ accumulated: "\n  Consider\nthis", round: 0 })).toBe(
      "> 💭 Consider\n> this",
    );
  });

  it("drops a round's streamed tail when its final content is blank", () => {
    // The turn record carries no segment for a blank round: once the round
    // boundary confirms it, the streamed tail leaves the display and the
    // next round attaches to the previous round's separator — never to a
    // dangling blank line.
    const output = createThinkingOutput();
    output.onText({ accumulated: "R1", round: 0 });
    output.endRound({ round: 0, content: "R1" });
    expect(output.onText({ accumulated: "junk tail", round: 1 })).toBe("R1\n\njunk tail");
    expect(output.endRound({ round: 1, content: "" })).toBe("R1");
    expect(output.onText({ accumulated: "R2", round: 2 })).toBe("R1\n\nR2");
    expect(output.endRound({ round: 2, content: "R2" })).toBe("R1\n\nR2");
    // Whitespace-only content is blank too: it never commits as a padded
    // empty segment with its own dangling separator.
    expect(output.onText({ accumulated: "padded tail", round: 3 })).toBe("R1\n\nR2\n\npadded tail");
    expect(output.endRound({ round: 3, content: " \n\n " })).toBe("R1\n\nR2");
    expect(output.onText({ accumulated: "R3", round: 4 })).toBe("R1\n\nR2\n\nR3");
  });

  it("commits newline-padded round content with only its edge padding removed", () => {
    const output = createThinkingOutput();
    output.onText({ accumulated: "R1", round: 0 });
    output.endRound({ round: 0, content: "R1" });
    // The model padded the round's content with newlines on both edges: the
    // live display and the committed segment never stack blank lines onto
    // the round separator. (A trailing SPACE is prose, not padding, and is
    // preserved — pinned by the re-emit test above.)
    expect(output.onText({ accumulated: "\n\nHello.\n\n", round: 1 })).toBe("R1\n\nHello.");
    expect(output.endRound({ round: 1, content: "\n\nHello.\n\n\n" })).toBe("R1\n\nHello.");
  });

  it("never ends a quote block with an empty continuation line", () => {
    const output = createThinkingOutput();
    // Reasoning that ends in "\n" must not render a trailing bare "> " —
    // it would break the Discord blockquote at that line.
    expect(output.onThinking({ accumulated: "Consider this\n", round: 0 })).toBe(
      "> 💭 Consider this",
    );
    expect(output.onThinking({ accumulated: "Consider this\nmore\n", round: 0 })).toBe(
      "> 💭 Consider this\n> more",
    );
  });

  it("enters a round's prose without streamed deltas at its boundary", () => {
    const output = createThinkingOutput();
    output.onText({ accumulated: "R1", round: 0 });
    output.endRound({ round: 0, content: "R1" });
    expect(output.endRound({ round: 1, content: "R2" })).toBe("R1\n\nR2");
  });

  it("maps every round's prose onto the final turn body verbatim", () => {
    // Terminal composition: the streamed snapshot is the turn-scoped prose
    // (rounds joined by the transcript separator), so the delivered body —
    // including decoration around the prose — lands verbatim, with the
    // streamed thinking quotes interleaved.
    const output = createThinkingOutput();
    output.onText({ accumulated: "R1", round: 0 });
    output.onThinking({ accumulated: "Thinking of R2", round: 0 });
    output.endRound({ round: 0, content: "R1" });
    output.onText({ accumulated: "R2 done", round: 1 });
    output.endRound({ round: 1, content: "R2 done" });
    expect(output.render("**Rook:**\nR1\n\nR2 done\n· m: test")).toBe(
      "**Rook:**\nR1\n\n> 💭 Thinking of R2\n\nR2 done\n· m: test",
    );
  });

  it("delivers the clean final prose when the stream diverged from the final content", () => {
    const output = createThinkingOutput();
    output.onText({ accumulated: "Streamed tail", round: 0 });
    output.onText({ accumulated: "Streamed replacement tail", round: 0 }); // mid-stream failover hop
    expect(output.render("**Rook:**\nClean final prose")).toBe("**Rook:**\nClean final prose");
  });
});
