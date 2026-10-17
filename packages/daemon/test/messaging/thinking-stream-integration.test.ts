import { describe, expect, it } from "vitest";
import { createThinkingOutput } from "../../src/messaging/thinking-output";
import { createSessionToolLoopModelClient } from "../../src/sessions/session-tool-loop-model-client";

interface StubRound {
  content: string;
  deltas?: string[];
  reasoning?: string[];
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
}

/** Drives the display pipeline exactly as the messaging surfaces do. */
function wireDisplayPipeline(rounds: StubRound[]) {
  const thinkingOutput = createThinkingOutput();
  const displays: string[] = [];
  let index = 0;
  const model = createSessionToolLoopModelClient({
    toolClient: {
      async completeWithTools(input: {
        onTextDelta?: (delta: string, accumulated: string) => void;
        onReasoningDelta?: (delta: string, accumulated: string) => void;
      }) {
        const round = rounds[index];
        index += 1;
        let reasoningAcc = "";
        for (const delta of round.reasoning ?? []) {
          reasoningAcc += delta;
          input.onReasoningDelta?.(delta, reasoningAcc);
        }
        let textAcc = "";
        for (const delta of round.deltas ?? []) {
          textAcc += delta;
          input.onTextDelta?.(delta, textAcc);
        }
        return {
          content: round.content,
          toolCalls: round.toolCalls ?? [],
          usedProviderId: "p",
          usedModel: "m",
          degraded: false,
        };
      },
    },
    initialMessages: [{ role: "user", content: "hi" }],
    tools: [],
    streamModel: true,
    onModelTextDelta: (ev) => {
      displays.push(thinkingOutput.onText(ev));
    },
    onThinkingDelta: (ev) => {
      displays.push(thinkingOutput.onThinking(ev));
    },
    onModelRoundEnd: (ev) => {
      displays.push(thinkingOutput.endRound(ev));
    },
  });
  return { model, thinkingOutput, displays };
}

const TOOL_CALL = { id: "t1", name: "no-such-tool", arguments: "{}" };

describe("tool-loop → thinking-output streaming pipeline", () => {
  it("keeps round separators single and in place across a multi-round tool loop", async () => {
    const { model, thinkingOutput, displays } = wireDisplayPipeline([
      {
        deltas: ["Checking ", "the repo."],
        content: "Checking the repo.",
        toolCalls: [TOOL_CALL],
      },
      { deltas: ["Done ", "now."], content: "Done now." },
    ]);

    await model.complete();
    model.pushToolMessage!({ toolCallId: "t1", content: "{}" });
    await model.complete();

    // The separator appears with the next round's first delta — never
    // glued mid-stream, never doubled, never trailing.
    expect(displays).toContain("Checking the repo.\n\nDone ");
    expect(displays.at(-1)).toBe("Checking the repo.\n\nDone now.");
    expect(displays.every((d) => !d.includes("\n\n\n"))).toBe(true);

    // Terminal composition: the streamed snapshot is the turn-scoped prose,
    // so the delivered body lands verbatim — no quotes-and-tail fallback.
    const turnProse = "Checking the repo.\n\nDone now.";
    expect(thinkingOutput.render(`**Rook:**\n${turnProse}\n· m: test`)).toBe(
      `**Rook:**\n${turnProse}\n· m: test`,
    );
  });

  it("opens a new quote block for re-emitted reasoning at the next round", async () => {
    const { model, displays } = wireDisplayPipeline([
      {
        reasoning: ["Planning the"],
        deltas: ["Step one."],
        content: "Step one.",
        toolCalls: [TOOL_CALL],
      },
      // The next round re-emits the prior reasoning (context quoting) and
      // continues it: the shared prefix renders where it first arrived, and
      // the new text opens its own 💭 block at the arrival position —
      // after the prose that streamed in between.
      {
        reasoning: ["Planning the", " steps"],
        deltas: ["Step two."],
        content: "Step two.",
      },
    ]);

    await model.complete();
    model.pushToolMessage!({ toolCallId: "t1", content: "{}" });
    await model.complete();

    const final = displays.at(-1)!;
    expect(final).toBe("> 💭 Planning the\n\nStep one.\n\n> 💭 steps\n\nStep two.");
    expect(final.split("💭").length - 1).toBe(2);
  });

  it("never splices cross-round reasoning into one block mid-word", async () => {
    const { model, displays } = wireDisplayPipeline([
      {
        reasoning: ["The issue says tests fail"],
        deltas: ["Looking around."],
        content: "Looking around.",
        toolCalls: [TOOL_CALL],
      },
      {
        // The round re-emits only a short shared prefix of the earlier
        // thought, then veers into unrelated reasoning — it must land in
        // its own block, never cut-and-glued onto the earlier one.
        reasoning: ["The iss", "look at how the parser is invoked"],
        deltas: ["Fixed."],
        content: "Fixed.",
      },
    ]);

    await model.complete();
    model.pushToolMessage!({ toolCallId: "t1", content: "{}" });
    await model.complete();

    const final = displays.at(-1)!;
    expect(final).toBe(
      "> 💭 The issue says tests fail\n\nLooking around.\n\n> 💭 look at how the parser is invoked\n\nFixed.",
    );
    expect(final).not.toContain("isslook");
    // The earlier block is untouched — no later round mutated it.
    expect(final).toContain("tests fail\n\nLooking around.");
  });

  it("never erases streamed prose when a fresh stream re-fires empty mid-round", async () => {
    const displays: string[] = [];
    const thinkingOutput = createThinkingOutput();
    let calls = 0;
    const model = createSessionToolLoopModelClient({
      toolClient: {
        async completeWithTools(input: {
          onTextDelta?: (delta: string, accumulated: string) => void;
        }) {
          calls += 1;
          input.onTextDelta?.("Streamed ", "Streamed ");
          input.onTextDelta?.("reply", "Streamed reply");
          // Provider retry / failover hop re-fires with a fresh buffer.
          input.onTextDelta?.("", "");
          input.onTextDelta?.("Streamed reply final", "Streamed reply final");
          return {
            content: "Streamed reply final",
            toolCalls: [],
            usedProviderId: "p",
            usedModel: "M",
            degraded: false,
          };
        },
      },
      initialMessages: [{ role: "user", content: "hi" }],
      tools: [],
      streamModel: true,
      onModelTextDelta: (ev) => {
        displays.push(thinkingOutput.onText(ev));
      },
      onModelRoundEnd: (ev) => {
        displays.push(thinkingOutput.endRound(ev));
      },
    });

    await model.complete();
    expect(calls).toBe(1);

    // The empty re-fire keeps the superseded prose visible (it used to be
    // spliced to zero, blanking the whole live message), and the fresh
    // stream replaces it without duplication.
    expect(displays).toContain("Streamed reply");
    expect(displays.every((d) => d.includes("Streamed"))).toBe(true);
    expect(displays.at(-1)).toBe("Streamed reply final");
  });

  it("reconciles a round's drifted streamed tail at the boundary without blank-line artifacts", async () => {
    const { model, thinkingOutput, displays } = wireDisplayPipeline([
      { deltas: ["R1"], content: "R1", toolCalls: [TOOL_CALL] },
      {
        deltas: ["Done ", "partial"],
        content: "Done.", // trimmed tail: the streamed "Done partial" drifts
        toolCalls: [TOOL_CALL],
      },
      { deltas: ["All green."], content: "All green." },
    ]);

    await model.complete();
    model.pushToolMessage!({ toolCallId: "t1", content: "{}" });
    await model.complete();
    model.pushToolMessage!({ toolCallId: "t2", content: "{}" });
    await model.complete();

    // The drifted tail is replaced by the authoritative content exactly
    // once, with a single separator before the next round.
    expect(displays.at(-1)).toBe("R1\n\nDone.\n\nAll green.");
    expect(displays.every((d) => !d.includes("\n\n\n"))).toBe(true);
    expect(displays.filter((d) => d.includes("All green.")).at(-1)).toBe(
      "R1\n\nDone.\n\nAll green.",
    );

    const turnProse = "R1\n\nDone.\n\nAll green.";
    expect(thinkingOutput.render(turnProse)).toBe(turnProse);
  });
});
