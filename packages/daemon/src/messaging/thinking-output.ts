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

  const update = (kind: ThinkingOutputKind, accumulated: string): string => {
    const previous = snapshots[kind];
    // The accumulated text is normally the previous snapshot plus a new
    // suffix (append-only stream). When it diverges — a round restart after
    // steering/failover whose final content differs from its streamed tail —
    // only the shared-prefix remainder is the delta: the whole accumulated
    // text must NEVER be re-pushed, or every earlier segment duplicates into
    // the rendered display.
    let shared = 0;
    const max = Math.min(previous.length, accumulated.length);
    while (shared < max && previous[shared] === accumulated[shared]) shared += 1;
    const diverged = shared < previous.length;
    const delta = diverged
      ? accumulated.slice(shared).replace(/^[^\S\n]*\n+/, "")
      : accumulated.slice(shared);
    snapshots[kind] = accumulated;
    if (!delta) return render();
    const last = parts.at(-1);
    if (!diverged && last?.kind === kind) last.text += delta;
    else parts.push({ kind, text: delta });
    return render();
  };

  const render = (finalText?: string): string => {
    const finalTextStart =
      finalText === undefined || !snapshots.text
        ? 0
        : Math.max(0, finalText.indexOf(snapshots.text));
    let textOffset = finalTextStart;
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
          finalText === undefined
            ? part.text
            : finalText.slice(
                textOffset,
                index === lastTextIndex ? undefined : textOffset + part.text.length,
              );
        textOffset =
          finalText !== undefined && index === lastTextIndex
            ? finalText.length
            : textOffset + part.text.length;
        if (prose) rendered.push(prose);
      } else if (part.text) {
        rendered.push(renderThinkingBlockquote(part.text));
      }
    }
    if (finalText !== undefined && parts.every((part) => part.kind === "thinking")) {
      rendered.push(finalText);
    } else if (finalText !== undefined && textOffset < finalText.length) {
      rendered.push(finalText.slice(textOffset));
    }
    return rendered.join("\n\n");
  };

  return {
    onText: (accumulated: string) => update("text", accumulated),
    onThinking: (accumulated: string) => update("thinking", accumulated),
    render,
  };
}
