import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkStringify from "remark-stringify";
import { visit, SKIP } from "unist-util-visit";
import type { Node } from "unist";
import stringWidth from "string-width";

type MdNode = Node & {
  children?: MdNode[];
  value?: string;
  type: string;
  align?: Array<"left" | "right" | "center" | null>;
  lang?: string;
};

function nodeText(node?: MdNode): string {
  if (!node) return "";
  if (node.type === "text") return node.value || "";
  if (node.type === "inlineCode") return node.value || "";
  if (node.type === "html") {
    // Strip HTML tags and return only text content
    const value = node.value || "";
    return value.replace(/<[^>]+>/g, "");
  }
  if (node.children) return node.children.map(nodeText).join("");
  return "";
}

const BOX = {
  tl: "┌",
  tr: "┐",
  bl: "└",
  br: "┘",
  tm: "┬",
  bm: "┴",
  lm: "├",
  rm: "┤",
  mm: "┼",
  h: "─",
  v: "│",
};

function borderRow(widths: number[], left: string, mid: string, right: string): string {
  return (
    left +
    widths
      .map((w: number, i: number) => BOX.h.repeat(w) + (i < widths.length - 1 ? mid : ""))
      .join("") +
    right
  );
}

/** Maximum total table width before responsive reflow kicks in. */
const MAX_TABLE_WIDTH = 80;
/** Maximum column content width when reflowing. */
const MAX_COL_WIDTH = 20;

/**
 * Wrap a string into lines that fit within `maxWidth` visual columns.
 * Prefers breaking at spaces; falls back to hard-breaking mid-word.
 */
function wrapText(text: string, maxWidth: number): string[] {
  if (stringWidth(text) <= maxWidth) return [text];

  const words = text.split(/( +)/); // keep spaces as separate tokens
  const lines: string[] = [];
  let cur = "";
  let curW = 0;

  /**
   * Hard-break a token that is wider than maxWidth, character by character,
   * appending resulting lines to `lines` and leaving the remainder in cur/curW.
   */
  function hardBreak(token: string): void {
    for (const ch of token) {
      const cw = stringWidth(ch);
      if (curW + cw > maxWidth && cur.length > 0) {
        lines.push(cur);
        cur = "";
        curW = 0;
      }
      cur += ch;
      curW += cw;
    }
  }

  for (const word of words) {
    const ww = stringWidth(word);
    if (curW + ww <= maxWidth) {
      cur += word;
      curW += ww;
    } else if (curW === 0) {
      // Single token wider than maxWidth — hard-break character by character
      hardBreak(word);
    } else {
      // Push current line (trim trailing spaces) and start fresh
      lines.push(cur.trimEnd());
      cur = "";
      curW = 0;
      // If the new word itself exceeds maxWidth, hard-break it too
      const trimmed = word.trimStart();
      if (stringWidth(trimmed) > maxWidth) {
        hardBreak(trimmed);
      } else {
        cur = trimmed;
        curW = stringWidth(cur);
      }
    }
  }
  if (cur.length > 0) lines.push(cur.trimEnd());
  return lines.length > 0 ? lines : [""];
}

function boxTable(cells: string[][], aligns: Array<"left" | "right" | "center">): string {
  if (cells.length === 0) return "";
  const colCount = Math.max(...cells.map((r: string[]) => r.length));
  if (colCount === 0) return "";

  // Compute natural (uncapped) column widths in visual columns
  const naturalWidths: number[] = Array.from({ length: colCount }, (_, c: number) =>
    Math.max(...cells.map((r: string[]) => stringWidth(r[c] ?? "")), 1),
  );

  // Total table width = sum(visualWidths) + 3*colCount + 1
  // (each col has +2 padding, +1 separator except last, +2 outer borders)
  const totalWidth = naturalWidths.reduce((a, b) => a + b, 0) + 3 * colCount + 1;

  // If table exceeds max width, redistribute column widths to fit.
  // Columns that naturally fit within the fair-share cap keep their width;
  // remaining budget is distributed among the wider columns.
  let widths: number[];
  if (totalWidth > MAX_TABLE_WIDTH) {
    const availableContent = MAX_TABLE_WIDTH - (3 * colCount + 1);
    widths = [...naturalWidths];

    // Iteratively assign fair-share caps: narrow columns lock in, freeing
    // budget for the wider ones, until stable.
    let remaining = availableContent;
    const locked = Array.from<boolean>({ length: colCount }).fill(false);
    let unlocked = colCount;

    for (;;) {
      const cap = Math.max(Math.floor(remaining / unlocked), MAX_COL_WIDTH);
      let changed = false;
      for (let c = 0; c < colCount; c++) {
        if (locked[c]) continue;
        if (naturalWidths[c] <= cap) {
          // This column fits naturally — lock it in at its natural width
          widths[c] = naturalWidths[c];
          remaining -= naturalWidths[c];
          locked[c] = true;
          unlocked--;
          changed = true;
        }
      }
      if (!changed) break;
    }

    // Cap all remaining (wide) columns to the final fair-share value
    if (unlocked > 0) {
      const finalCap = Math.max(Math.floor(remaining / unlocked), MAX_COL_WIDTH);
      for (let c = 0; c < colCount; c++) {
        if (!locked[c]) {
          widths[c] = finalCap;
        }
      }
    }
  } else {
    widths = naturalWidths;
  }

  const normAlign: Array<"left" | "right" | "center"> = Array.from(
    { length: colCount },
    (_, c: number) => aligns[c] ?? "left",
  );
  const innerW = widths.map((w: number) => w + 2);

  const top = borderRow(innerW, BOX.tl, BOX.tm, BOX.tr);
  const sep = borderRow(innerW, BOX.lm, BOX.mm, BOX.rm);
  const bot = borderRow(innerW, BOX.bl, BOX.bm, BOX.br);

  const needsWrap = totalWidth > MAX_TABLE_WIDTH;

  const lines: string[] = [top];

  /**
   * Render a logical row (which may span multiple visual lines when wrapping).
   */
  function renderRow(row: string[]): void {
    if (!needsWrap) {
      // Simple single-line row: pad each cell to widths[c] characters
      // (not visual width).  This ensures the data row character count
      // matches the border row, keeping box-drawing aligned.
      lines.push(
        BOX.v +
          row
            .map((cell: string, c: number) => {
              const padLen = widths[c] - cell.length;
              if (padLen <= 0) return " " + cell + " ";
              switch (normAlign[c]) {
                case "center": {
                  const l = Math.floor(padLen / 2);
                  return " " + " ".repeat(l) + cell + " ".repeat(padLen - l) + " ";
                }
                case "right":
                  return " " + " ".repeat(padLen) + cell + " ";
                default:
                  return " " + cell + " ".repeat(padLen) + " ";
              }
            })
            .join(BOX.v) +
          BOX.v,
      );
      return;
    }

    // Wrap each cell into multiple visual lines
    const wrapped: string[][] = row.map((cell: string, c: number) => wrapText(cell, widths[c]));
    const maxLines = Math.max(...wrapped.map((w) => w.length), 1);

    for (let ln = 0; ln < maxLines; ln++) {
      lines.push(
        BOX.v +
          wrapped
            .map((cellLines: string[], c: number) => {
              const content = cellLines[ln] ?? "";
              const padLen = widths[c] - content.length;
              if (padLen <= 0) return " " + content + " ";
              switch (normAlign[c]) {
                case "center": {
                  const l = Math.floor(padLen / 2);
                  return " " + " ".repeat(l) + content + " ".repeat(padLen - l) + " ";
                }
                case "right":
                  return " " + " ".repeat(padLen) + content + " ";
                default:
                  return " " + content + " ".repeat(padLen) + " ";
              }
            })
            .join(BOX.v) +
          BOX.v,
      );
    }
  }

  renderRow(cells[0]);
  lines.push(sep);
  for (let i = 1; i < cells.length; i++) {
    renderRow(cells[i]);
    if (needsWrap && i < cells.length - 1) {
      lines.push(sep);
    }
  }

  lines.push(bot);
  return lines.join("\n");
}

export function mdTableToAscii(md: string): string {
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkStringify);
  const tree = processor.parse(md) as any;

  let foundTable = false;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  visit(tree as any, "table", (tableNode: any, index: any, parent: any) => {
    if (index == null) return;
    foundTable = true;

    const cells: string[][] = (tableNode.children ?? [])
      .map((row: any) => (row.children ?? []).map((cell: any) => nodeText(cell as MdNode).trim()))
      .filter((row: string[]) => row.some((c: string) => c.length > 0));

    const aligns: Array<"left" | "right" | "center"> = (tableNode.align ?? []).map(
      (a: string | null | undefined) =>
        a === "left" ? "left" : a === "right" ? "right" : a === "center" ? "center" : "left",
    );

    parent.children!.splice(index, 1, {
      type: "code",
      lang: "text",
      value: boxTable(cells, aligns),
    });
    return SKIP;
  });

  if (!foundTable) return md;

  // remark-stringify adds inter-block blank lines and a trailing newline.
  // Normalize: collapse 3+ newlines to 2, close code blocks tight, strip trailing.
  return processor
    .stringify(tree as any)
    .replace(/\n{3,}/g, "\n\n") // 3+ blanks -> 2
    .replace(/```\n\n/g, "```\n") // close code block + blank -> close code block
    .replace(/\n$/, ""); // no trailing newline
}
