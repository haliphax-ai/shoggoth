import { renderThinkingBlockquote } from "@shoggoth/shared";

export type ThinkingOutputKind = "text" | "thinking";

/** A streaming event scoped to one tool-loop round. */
export interface ThinkingStreamEvent {
  /** The round's accumulated content so far — never glued to other rounds. */
  readonly accumulated: string;
  /** Zero-based index of the tool-loop round this accumulation belongs to. */
  readonly round: number;
}

/** A settled tool-loop round with its authoritative final prose content. */
export interface ThinkingRoundEndEvent {
  readonly round: number;
  /** The round's final content as recorded in the transcript (may be blank). */
  readonly content: string;
}

interface OutputPart {
  kind: ThinkingOutputKind;
  text: string;
  /** Tool-loop round that produced this part; round boundaries split parts. */
  round: number;
}

/**
 * Strips leading padding so a quote block never opens with a blank `> ` line
 * (leading newline) or a doubled space after the 💭 marker (leading space).
 */
const quoteBody = (text: string): string => text.replace(/^\s+/, "");

/** Tracks cumulative model deltas as ordered text/thinking segments for display. */
export function createThinkingOutput() {
  const parts: OutputPart[] = [];
  /** The current round's accumulated prose stream (divergence base). */
  let textRoundStream = "";
  /** The round the prose stream currently belongs to (-1: none yet). */
  let textRound = -1;
  /**
   * Index in the turn stream where the current round's contribution starts.
   * The contribution carries the blank-line separator when prior rounds
   * already contributed, so dropping or rewriting the round is exact.
   */
  let textRoundBase = 0;
  /**
   * Whole-turn prose: rounds joined with the transcript's blank-line
   * separator so it maps 1:1 onto the delivered turn prose.
   */
  let turnText = "";
  /**
   * Reasoning state, round-scoped exactly like prose: `thinkRound` is the
   * round the reasoning stream belongs to, `thinkStream` is that round's
   * raw accumulated reasoning, and `thinkShown` is what this round has
   * contributed to the display (its 💭 parts concatenate to exactly this).
   * A new round NEVER diffs against — or mutates — an earlier round's parts.
   */
  let thinkRound = -1;
  let thinkStream = "";
  let thinkShown = "";
  /**
   * The provider's cumulative reasoning BEFORE the current round. Many
   * providers re-emit the prior reasoning at the start of a new tool-loop
   * round (context quoting, not one continuous thought): the still-matching
   * prefix is stripped from each new round so it renders only where it first
   * arrived, and the new round opens its own 💭 block with only the new text.
   */
  let thinkTurnBase = "";

  const lastPartIndex = (kind: ThinkingOutputKind): number => {
    for (let index = parts.length - 1; index >= 0; index -= 1) {
      if (parts[index].kind === kind) return index;
    }
    return -1;
  };

  /** Index of the LAST 💭 part belonging to `round` (round-scoped append target). */
  const lastThinkingPartIndex = (round: number): number => {
    for (let index = parts.length - 1; index >= 0; index -= 1) {
      const part = parts[index];
      if (part.kind === "thinking" && part.round === round) return index;
    }
    return -1;
  };

  /** Folds a settled round's raw reasoning into the provider's cumulative view. */
  const extendTurnReasoningBase = (base: string, stream: string): string => {
    if (!stream) return base;
    if (stream.startsWith(base)) return stream; // the round extended the prior view
    if (base.startsWith(stream)) return base; // the round re-emitted a subset of it
    return base + stream; // unrelated reasoning: keep both for future stripping
  };

  const nextTextPartAfter = (index: number): number | undefined => {
    for (let next = index + 1; next < parts.length; next += 1) {
      if (parts[next].kind === "text") return next;
    }
    return undefined;
  };

  /**
   * Truncates the `kind` stream inside `parts` (only parts from `minRound`
   * on — earlier rounds are settled history) to its first `keep`
   * characters. The parts of one kind concatenate (in order) to that kind's
   * stream, so this cuts at the right offset, trims the part holding the
   * cut, and drops every part of this kind past it. Returns the index of
   * the trimmed part, or -1 when this kind has no matching parts (or the
   * cut lands exactly at its end — no part needs trimming).
   */
  const spliceStream = (kind: ThinkingOutputKind, keep: number, minRound: number): number => {
    const indices = parts.flatMap((part, index) =>
      part.kind === kind && part.round >= minRound ? [index] : [],
    );
    let remaining = keep;
    let cutOrdinal = indices.length;
    for (let ordinal = 0; ordinal < indices.length; ordinal += 1) {
      const part = parts[indices[ordinal]];
      if (remaining < part.text.length) {
        part.text = part.text.slice(0, remaining);
        cutOrdinal = ordinal;
        break;
      }
      remaining -= part.text.length;
    }
    for (let ordinal = indices.length - 1; ordinal > cutOrdinal; ordinal -= 1) {
      parts.splice(indices[ordinal], 1);
    }
    return cutOrdinal < indices.length ? indices[cutOrdinal] : -1;
  };

  const dropRoundText = (round: number): void => {
    for (let index = parts.length - 1; index >= 0; index -= 1) {
      const part = parts[index];
      if (part.kind === "text" && part.round === round) parts.splice(index, 1);
    }
    turnText = turnText.slice(0, textRoundBase);
    textRoundStream = "";
  };

  /** Opens the prose stream for a new round; the separator materializes lazily. */
  const enterRoundText = (round: number): void => {
    textRound = round;
    textRoundStream = "";
    textRoundBase = turnText.length;
  };

  /** Writes the round's stream into the turn text (separator included). */
  const commitRoundText = (accumulated: string): void => {
    textRoundStream = accumulated;
    turnText =
      turnText.slice(0, textRoundBase) + (textRoundBase > 0 ? `\n\n${accumulated}` : accumulated);
  };

  const updateText = ({ accumulated, round }: ThinkingStreamEvent): string => {
    if (round !== textRound) enterRoundText(round);
    // The accumulated text is normally the round's previous stream plus a new
    // suffix (append-only stream). When it diverges — a provider retry /
    // failover hop re-fires the round from scratch — only the shared-prefix
    // remainder is new: the whole accumulated text must NEVER be re-pushed,
    // or every earlier segment duplicates into the rendered display.
    const previous = textRoundStream;
    let shared = 0;
    const max = Math.min(previous.length, accumulated.length);
    while (shared < max && previous[shared] === accumulated[shared]) shared += 1;
    const diverged = shared < previous.length;
    if (!diverged) {
      if (accumulated.length > previous.length) {
        const delta = accumulated.slice(shared);
        textRoundStream = accumulated;
        turnText += delta;
        const last = parts.at(-1);
        // Prose continues its own round's part; a round boundary always
        // opens a fresh part so the round separator never lands mid-part,
        // and prose resuming after slipstreamed thinking opens a fresh part.
        if (last?.kind === "text" && last.round === round) last.text += delta;
        else parts.push({ kind: "text", text: delta, round });
      }
      return render();
    }
    // Diverged within the round. An EMPTY remainder must never splice the
    // display to zero: the superseded tail stays visible until a non-empty
    // replacement arrives (or endRound confirms the round's final content).
    const remainder = accumulated.slice(shared);
    if (!remainder) return render();
    commitRoundText(accumulated);
    // A diverged continuation merges into the part holding the cut point —
    // opening a new part would split the prose with a blank line mid-word.
    // Only a genuine restart (no cut part) opens one.
    const cutIndex = spliceStream("text", shared, round);
    if (cutIndex >= 0) parts[cutIndex].text += remainder;
    else parts.push({ kind: "text", text: remainder, round });
    return render();
  };

  const updateThinking = ({ accumulated, round }: ThinkingStreamEvent): string => {
    // Reasoning is round-scoped: within a round it continues that round's
    // 💭 part; a NEW round never diffs against (or splices into) an earlier
    // round's parts. A cross-round prefix match is provider context quoting,
    // so the still-shared prefix is stripped — it already rendered where it
    // first arrived — and only the new text opens a 💭 part here.
    if (round !== thinkRound) {
      if (thinkRound >= 0) thinkTurnBase = extendTurnReasoningBase(thinkTurnBase, thinkStream);
      thinkRound = round;
      thinkStream = "";
      thinkShown = "";
    }
    thinkStream = accumulated;
    let stripped = 0;
    const stripMax = Math.min(accumulated.length, thinkTurnBase.length);
    while (stripped < stripMax && accumulated[stripped] === thinkTurnBase[stripped]) stripped += 1;
    const shown = accumulated.slice(stripped);
    const previous = thinkShown;
    let shared = 0;
    const max = Math.min(previous.length, shown.length);
    while (shared < max && previous[shared] === shown[shared]) shared += 1;
    const diverged = shared < previous.length;
    if (!diverged) {
      if (shown.length > previous.length) {
        const delta = shown.slice(shared);
        thinkShown = shown;
        // Within the round, reasoning continues the round's 💭 part; a round
        // with no open 💭 part yet opens one at the current position.
        const lastIdx = lastThinkingPartIndex(round);
        if (lastIdx >= 0) parts[lastIdx].text += delta;
        else parts.push({ kind: "thinking", text: delta, round });
      }
      return render();
    }
    // Diverged WITHIN the round (a provider retry / failover hop re-fires
    // the round's reasoning). An EMPTY remainder keeps the superseded quote
    // visible — never splice it to zero mid-turn. The merge only touches
    // THIS round's parts (spliceStream is minRound-scoped), so a round's
    // remainder can never glue onto another round's text mid-word.
    const remainder = shown.slice(shared);
    if (!remainder) return render();
    thinkShown = shown;
    const cutIndex = spliceStream("thinking", shared, round);
    if (cutIndex >= 0) parts[cutIndex].text += remainder;
    else parts.push({ kind: "thinking", text: remainder, round });
    return render();
  };

  /**
   * Reconciles the round's streamed prose tail with its authoritative final
   * content and confirms the round boundary: a blank final content drops the
   * round's streamed tail from the display (the turn record carries no such
   * segment), and a settled round with content but no streamed deltas enters
   * the display as its own segment.
   */
  const endRound = ({ round, content }: ThinkingRoundEndEvent): string => {
    if (textRound === round) {
      if (!content) {
        dropRoundText(round);
        return render();
      }
      const previous = textRoundStream;
      let shared = 0;
      const max = Math.min(previous.length, content.length);
      while (shared < max && previous[shared] === content[shared]) shared += 1;
      const diverged = shared < previous.length;
      const remainder = content.slice(shared);
      commitRoundText(content);
      if (!diverged) {
        // The final content extends the streamed tail (late deltas were
        // recorded in the transcript only): append to the round's part.
        if (remainder) {
          const lastIdx = lastPartIndex("text");
          if (lastIdx >= 0 && parts[lastIdx].round === round) parts[lastIdx].text += remainder;
          else parts.push({ kind: "text", text: remainder, round });
        }
      } else if (remainder) {
        const cutIndex = spliceStream("text", shared, round);
        if (cutIndex >= 0) parts[cutIndex].text += remainder;
        else parts.push({ kind: "text", text: remainder, round });
      } else {
        // The final content is a trimmed prefix of the streamed tail — the
        // round boundary confirms the restart, so the junk tail is cut.
        spliceStream("text", shared, round);
      }
      return render();
    }
    if (content && round > textRound) {
      // The round produced prose without streaming deltas (or endRound ran
      // ahead of the display stream): record it as its own round segment.
      enterRoundText(round);
      commitRoundText(content);
      parts.push({ kind: "text", text: content, round });
    }
    return render();
  };

  const render = (finalText?: string): string => {
    const snapshot = turnText;
    const snapshotStart = finalText === undefined || !snapshot ? 0 : finalText.indexOf(snapshot);
    if (finalText !== undefined && snapshotStart < 0) {
      // The streamed display no longer matches the turn's final prose (a
      // mid-stream failover hop, a trimmed tail). The clean turn record
      // wins: deliver finalText verbatim with any streamed thinking quoted
      // above it. Slicing finalText by the streamed parts' offsets here
      // would cut words apart and re-insert blank lines mid-word.
      const quotes = parts
        .map((part) => (part.kind === "thinking" ? quoteBody(part.text) : ""))
        .filter((body) => body !== "")
        .map(renderThinkingBlockquote);
      return quotes.length > 0 ? [...quotes, finalText].join("\n\n") : finalText;
    }
    // When the streamed snapshot is found inside finalText, the parts map
    // onto the prose region only; the decoration around it (identity /
    // degraded prefix, model-tag footer) is carried through verbatim.
    const proseStart = snapshotStart;
    const proseEnd =
      finalText !== undefined && snapshot ? snapshotStart + snapshot.length : finalText?.length;
    const head = finalText !== undefined && snapshot ? finalText.slice(0, proseStart) : "";
    const tail = finalText !== undefined && snapshot ? finalText.slice(proseEnd) : "";
    const region = finalText === undefined ? undefined : finalText.slice(proseStart, proseEnd);
    let textOffset = 0;
    const rendered: string[] = [];
    let lastTextIndex = -1;
    for (let index = parts.length - 1; index >= 0; index--) {
      if (parts[index].kind === "text") {
        lastTextIndex = index;
        break;
      }
    }
    for (const [index, part] of parts.entries()) {
      if (part.kind === "text") {
        const prose =
          region === undefined
            ? part.text
            : region.slice(
                textOffset,
                index === lastTextIndex ? undefined : textOffset + part.text.length,
              );
        if (region !== undefined) {
          textOffset = index === lastTextIndex ? region.length : textOffset + part.text.length;
          // A round boundary between prose parts carries the transcript's
          // blank-line round separator — step the region offset past it.
          // Same-round parts (prose split by slipstreamed thinking) have no
          // separator in the region.
          const nextText = index === lastTextIndex ? undefined : nextTextPartAfter(index);
          if (nextText !== undefined && parts[nextText].round !== part.round) textOffset += 2;
        }
        if (prose) rendered.push(prose);
      } else if (part.text) {
        const body = quoteBody(part.text);
        if (body) rendered.push(renderThinkingBlockquote(body));
      }
    }
    if (region !== undefined && parts.every((part) => part.kind === "thinking" || !part.text)) {
      rendered.push(region);
    } else if (region !== undefined && textOffset < region.length) {
      rendered.push(region.slice(textOffset));
    }
    const body = rendered.join("\n\n");
    return finalText === undefined ? body : `${head}${body}${tail}`;
  };

  return {
    onText: (ev: ThinkingStreamEvent) => updateText(ev),
    onThinking: (ev: ThinkingStreamEvent) => updateThinking(ev),
    endRound: (ev: ThinkingRoundEndEvent) => endRound(ev),
    render,
  };
}
