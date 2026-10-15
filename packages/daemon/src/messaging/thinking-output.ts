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
    const delta = accumulated.startsWith(previous)
      ? accumulated.slice(previous.length)
      : accumulated;
    snapshots[kind] = accumulated;
    if (!delta) return render();
    const last = parts.at(-1);
    if (last?.kind === kind) last.text += delta;
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
        const quote = part.text
          .split("\n")
          .map((line) => `> 💭 ${line}`)
          .join("\n");
        rendered.push(quote);
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
