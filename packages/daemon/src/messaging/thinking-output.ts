import { renderThinkingBlockquote } from "@shoggoth/shared";

export type ThinkingOutputKind = "text" | "thinking";

interface OutputPart {
  kind: ThinkingOutputKind;
  text: string;
}

/** Tracks cumulative model deltas as ordered text/thinking segments for display. */
export function createThinkingOutput() {
  const parts: OutputPart[] = [];
  const snapshots: Record<ThinkingOutputKind, string> = { text: "", thinking: "" };

  /**
   * Truncates the `kind` stream inside `parts` to its first `keep`
   * characters. The parts of one kind concatenate (in order) to that kind's
   * previous snapshot, so this cuts at the right offset, trims the part
   * holding the cut, and drops every part of this kind past it. Returns the
   * index of the trimmed part, or -1 when this kind has no parts (or the cut
   * lands exactly at its end — no part needs trimming).
   */
  const spliceStream = (kind: ThinkingOutputKind, keep: number): number => {
    const indices = parts.flatMap((part, index) => (part.kind === kind ? [index] : []));
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

  const update = (kind: ThinkingOutputKind, accumulated: string): string => {
    const previous = snapshots[kind];
    // The accumulated text is normally the previous snapshot plus a new
    // suffix (append-only stream). When it diverges — a round restart after
    // steering/failover whose final content differs from its streamed tail —
    // only the shared-prefix remainder is new: the whole accumulated text
    // must NEVER be re-pushed, or every earlier segment duplicates into the
    // rendered display.
    let shared = 0;
    const max = Math.min(previous.length, accumulated.length);
    while (shared < max && previous[shared] === accumulated[shared]) shared += 1;
    const diverged = shared < previous.length;
    snapshots[kind] = accumulated;
    if (!diverged) {
      if (accumulated.length > previous.length) {
        const delta = accumulated.slice(shared);
        const last = parts.at(-1);
        if (last?.kind === kind) last.text += delta;
        else parts.push({ kind, text: delta });
      }
      return render();
    }
    // Diverged: splice this stream's parts back to the shared prefix and
    // merge the remainder into the part holding the cut point. A stream
    // continuation must NOT open a new part: parts are joined with a
    // formatting blank line, which would otherwise land mid-word at the
    // divergence point (and give a restarted thinking tail its own spurious
    // quoted block). Only a genuine restart (no cut part) opens one.
    const cutIndex = spliceStream(kind, shared);
    const remainder = accumulated.slice(shared);
    if (!remainder) return render();
    if (cutIndex >= 0) parts[cutIndex].text += remainder;
    else parts.push({ kind, text: remainder.replace(/^[^\S\n]*\n+/, "") });
    return render();
  };

  const render = (finalText?: string): string => {
    const snapshot = snapshots.text;
    const snapshotStart = finalText === undefined || !snapshot ? 0 : finalText.indexOf(snapshot);
    if (finalText !== undefined && snapshotStart < 0) {
      // The streamed display no longer matches the turn's final prose (a
      // mid-stream failover hop, a trimmed tail). The clean turn record
      // wins: deliver finalText verbatim with any streamed thinking quoted
      // above it. Slicing finalText by the streamed parts' offsets here
      // would cut words apart and re-insert blank lines mid-word.
      const quotes = parts
        .filter((part) => part.kind === "thinking" && part.text)
        .map((part) => renderThinkingBlockquote(part.text));
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
        textOffset =
          region !== undefined && index === lastTextIndex
            ? region.length
            : textOffset + part.text.length;
        if (prose) rendered.push(prose);
      } else if (part.text) {
        rendered.push(renderThinkingBlockquote(part.text));
      }
    }
    if (region !== undefined && parts.every((part) => part.kind === "thinking")) {
      rendered.push(region);
    } else if (region !== undefined && textOffset < region.length) {
      rendered.push(region.slice(textOffset));
    }
    const body = rendered.join("\n\n");
    return finalText === undefined ? body : `${head}${body}${tail}`;
  };

  return {
    onText: (accumulated: string) => update("text", accumulated),
    onThinking: (accumulated: string) => update("thinking", accumulated),
    render,
  };
}
