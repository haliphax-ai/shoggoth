import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkStringify from "remark-stringify";
import { visit, SKIP } from "unist-util-visit";
import type { Node } from "unist";

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
  if (node.children) return node.children.map(nodeText).join("");
  return "";
}

function classifyCp(cp: number): 0 | 1 | 2 {
  if (
    cp === 0xfe0f ||
    cp === 0xfe0e ||
    cp === 0x200d ||
    cp === 0x200c ||
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xe0100 && cp <= 0xe01ef)
  ) {
    return 0;
  }
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x2fff) ||
    (cp >= 0x3000 && cp <= 0x9fff) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff01 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1b000 && cp <= 0x1b0ff) ||
    (cp >= 0x20000 && cp <= 0x2fffd) ||
    (cp >= 0x30000 && cp <= 0x3fffd) ||
    (cp >= 0x2300 && cp <= 0x23ff) ||
    (cp >= 0x25a0 && cp <= 0x27bf) ||
    (cp >= 0x1f000 && cp <= 0x1ffff)
  ) {
    return 2;
  }
  return 1;
}

function visualWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    w += classifyCp(ch.codePointAt(0)!);
  }
  return w;
}

function padVisual(cell: string, targetWidth: number, align: "left" | "right" | "center"): string {
  const cur = visualWidth(cell);
  const padLen = targetWidth - cur;
  if (padLen <= 0) return cell;
  switch (align) {
    case "center": {
      const l = Math.floor(padLen / 2);
      return " ".repeat(l) + cell + " ".repeat(padLen - l);
    }
    case "right":
      return " ".repeat(padLen) + cell;
    default:
      return cell + " ".repeat(padLen);
  }
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

function boxTable(cells: string[][], aligns: Array<"left" | "right" | "center">): string {
  if (cells.length === 0) return "";
  const colCount = Math.max(...cells.map((r: string[]) => r.length));
  if (colCount === 0) return "";

  const widths: number[] = Array.from({ length: colCount }, (_, c: number) =>
    Math.max(...cells.map((r: string[]) => visualWidth(r[c] ?? "")), 1),
  );
  const normAlign: Array<"left" | "right" | "center"> = Array.from(
    { length: colCount },
    (_, c: number) => aligns[c] ?? "left",
  );
  const innerW = widths.map((w: number) => w + 2);

  const top = borderRow(innerW, BOX.tl, BOX.tm, BOX.tr);
  const sep = borderRow(innerW, BOX.lm, BOX.mm, BOX.rm);
  const bot = borderRow(innerW, BOX.bl, BOX.bm, BOX.br);

  const lines: string[] = [top];

  const header = cells[0];
  lines.push(
    BOX.v +
      header
        .map((cell: string, c: number) => " " + padVisual(cell, widths[c], normAlign[c]) + " ")
        .join(BOX.v) +
      BOX.v,
  );
  lines.push(sep);

  for (let i = 1; i < cells.length; i++) {
    const row = cells[i];
    lines.push(
      BOX.v +
        row
          .map((cell: string, c: number) => " " + padVisual(cell, widths[c], normAlign[c]) + " ")
          .join(BOX.v) +
        BOX.v,
    );
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
