import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
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

/** Width of the widest whitespace-separated token in a cell. */
function maxTokenWidth(cell: string): number {
  let max = 0;
  for (const token of cell.split(" ")) {
    const w = stringWidth(token);
    if (w > max) max = w;
  }
  return max;
}

/** Maximum total table width before responsive reflow kicks in. */
const MAX_TABLE_WIDTH = 80;

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
   * Hard-break a token that is wider than maxWidth, character by character.
   * Pure: appends completed lines to `lines` and returns the carry-in state
   * for the next token instead of mutating `cur`/`curW` via closure.
   */
  function hardBreak(token: string, curIn: string, curWIn: number): string {
    for (const ch of token) {
      const cw = stringWidth(ch);
      if (curWIn + cw > maxWidth && curIn.length > 0) {
        lines.push(curIn);
        curIn = "";
        curWIn = 0;
      }
      curIn += ch;
      curWIn += cw;
    }
    return curIn;
  }

  for (const word of words) {
    const ww = stringWidth(word);
    if (curW + ww <= maxWidth) {
      cur += word;
      curW += ww;
    } else if (curW === 0) {
      // Single token wider than maxWidth — hard-break character by character
      cur = hardBreak(word, cur, curW);
    } else {
      // Push current line (trim trailing spaces) and start fresh
      lines.push(cur.trimEnd());
      cur = "";
      curW = 0;
      // If the new word itself exceeds maxWidth, hard-break it too
      const trimmed = word.trimStart();
      if (stringWidth(trimmed) > maxWidth) {
        cur = hardBreak(trimmed, "", 0);
      } else {
        cur = trimmed;
        curW = stringWidth(cur);
      }
    }
  }
  if (cur.length > 0) lines.push(cur.trimEnd());
  return lines.length > 0 ? lines : [""];
}

/**
 * Distribute the content-column budget across columns. Every column is
 * guaranteed at least its longest token's width (so words wrap at spaces
 * instead of being hard-broken whenever possible); columns whose remaining
 * wrap-need fits within the even share then lock in at their natural width,
 * and the leftover budget is shared by the rest in proportion to how much
 * wrapping they need. The budget is fully used whenever the natural widths
 * allow it. When even the per-token minimums cannot fit, the floors
 * themselves are squeezed proportionally. Pure — returns a fresh array.
 */
function distributeColumnWidths(
  availableContent: number,
  naturalWidths: number[],
  minTokenWidths: number[],
): number[] {
  const colCount = naturalWidths.length;
  if (colCount === 0) return [];
  if (availableContent <= 0) return naturalWidths.map(() => 1);

  const floors = minTokenWidths.map((w) => Math.max(w, 1));
  const floorTotal = floors.reduce((a, b) => a + b, 0);
  if (floorTotal > availableContent) return squeezedFloors(availableContent, floors);

  const demand = naturalWidths.map((n, c) => n - floors[c]);
  const state = lockFittingColumns(availableContent, naturalWidths, demand, floors);
  shareLeftover(state, demand);
  return state.widths;
}

/** Squeeze floors proportionally when even the minimums cannot fit. */
function squeezedFloors(availableContent: number, floors: number[]): number[] {
  const floorTotal = floors.reduce((a, b) => a + b, 0);
  const absorber = floors.length - 1;
  const widths: number[] = [];
  let assigned = 0;
  for (let c = 0; c < floors.length; c++) {
    if (c === absorber) continue;
    widths[c] = Math.max(
      Math.min(Math.floor((availableContent * floors[c]) / floorTotal), floors[c]),
      1,
    );
    assigned += widths[c];
  }
  widths[absorber] = Math.max(Math.min(availableContent - assigned, floors[absorber]), 1);
  return widths;
}

/**
 * Give columns whose remaining wrap-need fits within the even share of the
 * leftover budget their full natural width (repeat until stable), so the
 * rest of the budget can be shared by the columns that actually wrap.
 */
function lockFittingColumns(
  availableContent: number,
  naturalWidths: number[],
  demand: number[],
  floors: number[],
): { widths: number[]; locked: boolean[]; leftover: number; unlocked: number } {
  const colCount = naturalWidths.length;
  const widths = [...floors];
  const locked = Array.from<boolean>({ length: colCount }).fill(false);
  let leftover = availableContent;
  for (const w of floors) leftover -= w;
  let unlocked = colCount;

  for (;;) {
    if (unlocked === 0) break;
    const cap = Math.floor(leftover / unlocked);
    let changed = false;
    for (let c = 0; c < colCount; c++) {
      if (locked[c] || demand[c] > cap) continue;
      widths[c] = naturalWidths[c];
      leftover -= demand[c];
      locked[c] = true;
      unlocked--;
      changed = true;
    }
    if (!changed) break;
  }
  return { widths, locked, leftover, unlocked };
}

/** Share the leftover budget over unlocked columns by wrap-need weight. */
function shareLeftover(
  state: { widths: number[]; locked: boolean[]; leftover: number; unlocked: number },
  demand: number[],
): void {
  const { widths, locked } = state;
  if (state.unlocked === 0) return;

  let tailDemand = 0;
  let absorber = -1;
  for (let c = 0; c < demand.length; c++) {
    if (locked[c]) continue;
    tailDemand += demand[c];
    absorber = c;
  }
  const budget = Math.max(state.leftover, 0);
  let used = 0;
  for (let c = 0; c < demand.length; c++) {
    if (locked[c]) continue;
    const extra =
      c === absorber
        ? Math.min(budget - used, demand[c])
        : Math.min(Math.floor((budget * demand[c]) / tailDemand), demand[c]);
    widths[c] += Math.max(extra, 0);
    used += extra;
  }
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

  // Over budget: narrow columns keep natural width; the leftover is shared
  // by the wrapping columns proportionally to their wrap-need, so the
  // budget is fully used instead of flattening every wide column to one cap.
  let widths: number[];
  if (totalWidth > MAX_TABLE_WIDTH) {
    const availableContent = MAX_TABLE_WIDTH - (3 * colCount + 1);
    const minTokenWidths = naturalWidths.map((_, c) =>
      Math.max(...cells.map((r) => maxTokenWidth(r[c] ?? "")), 1),
    );
    widths = distributeColumnWidths(availableContent, naturalWidths, minTokenWidths);
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
      // Simple single-line row: pad each cell so its visual width equals\n      // widths[c].  This keeps the data row's visual width equal to the\n      // border row, keeping box-drawing aligned even with wide codepoints.
      lines.push(
        BOX.v +
          row
            .map((cell: string, c: number) => {
              const padLen = widths[c] - stringWidth(cell);
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

    // Wrap each cell into multiple visual lines (wrapText hard-breaks any
    // content wider than the column, so no row line can overflow the border)
    const wrapped: string[][] = row.map((cell: string, c: number) => wrapText(cell, widths[c]));
    const maxLines = Math.max(...wrapped.map((w) => w.length), 1);

    for (let ln = 0; ln < maxLines; ln++) {
      lines.push(
        BOX.v +
          wrapped
            .map((cellLines: string[], c: number) => {
              const content = cellLines[ln] ?? "";
              const padLen = widths[c] - stringWidth(content);
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

/**
 * Module-level singleton processor. The parse call site is stateless (the
 * AST is consumed synchronously and never mutated), so a shared processor
 * avoids rebuilding the remark plugin pipeline per call — streaming edits
 * re-parse the growing body on every coalesced push.
 */
const mdProcessor = unified().use(remarkParse).use(remarkGfm);

export function mdTableToAscii(md: string): string {
  const tree = mdProcessor.parse(md) as any;

  let result = "";
  let cursor = 0;
  let foundTable = false;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  visit(tree as any, "table", (tableNode: any) => {
    foundTable = true;

    const cells: string[][] = (tableNode.children ?? [])
      .map((row: any) => (row.children ?? []).map((cell: any) => nodeText(cell as MdNode).trim()))
      .filter((row: string[]) => row.some((c: string) => c.length > 0));

    const aligns: Array<"left" | "right" | "center"> = (tableNode.align ?? []).map(
      (a: string | null | undefined) =>
        a === "left" ? "left" : a === "right" ? "right" : a === "center" ? "center" : "left",
    );

    // Splice the boxed table into the original text by source offsets:
    // re-serializing would rewrite unrelated markdown (remark-stringify emits
    // empty blockquote lines as bare `>`); outside the table stays byte-identical.
    const start: number | undefined = tableNode.position?.start?.offset;
    const end: number | undefined = tableNode.position?.end?.offset;
    if (start == null || end == null || start < cursor) return SKIP;

    result += md.slice(cursor, start) + "```text\n" + boxTable(cells, aligns) + "\n```";
    cursor = end;
    return SKIP;
  });

  if (!foundTable) return md;
  return result + md.slice(cursor);
}
