import { test, expect } from "vitest";
import { mdTableToAscii } from "../src/table-formatter";

const md = [
  "| Planet | Diameter (km) | Moons | Type |",
  "|---|---|---|---|",
  "| Mercury | 4,879 | 0 | Rocky |",
  "| Venus | 12,104 | 0 | Rocky |",
  "| Earth | 12,756 | 1 | Rocky |",
  "| Mars | 6,792 | 2 | Rocky |",
  "| Jupiter | 142,984 | 95 | Gas Giant |",
  "",
].join("\n");

test("renders Markdown table as Unicode box-drawing code block", () => {
  const result = mdTableToAscii(md);

  expect(result).toContain("```text");
  expect(result).toContain("```");

  const codeMatch = result.match(/```text\n([\s\S]*?)```/);
  expect(codeMatch).toBeTruthy();
  const box = codeMatch![1].trim();

  expect(box).toContain("┌");
  expect(box).toContain("┬");
  expect(box).toContain("├");
  expect(box).toContain("┼");
  expect(box).toContain("─");
  expect(box).toContain("│");

  const lines = box.split("\n");
  expect(lines[0]).toMatch(/^┌.*┐$/);
  expect(lines[lines.length - 1]).toMatch(/^└.*┘$/);

  expect(box).toContain("Mercury");

  const dataLines = lines.filter(
    (l) => l.startsWith("│") && !l.includes("├") && !l.includes("┴") && !l.includes("┬"),
  );
  expect(dataLines.length).toBe(6);
});

test("inline code in table cells is not stripped", () => {
  const md2 = [
    "| Command | Description |",
    "|---|---|",
    "| `git add` | Stage changes |",
    "| `git commit -m` | Commit with message |",
    "| `git push` | Push to remote |",
    "",
  ].join("\n");
  const result = mdTableToAscii(md2);
  expect(result).toContain("git add");
  expect(result).toContain("git commit -m");
  expect(result).toContain("git push");
  expect(result).toContain("Stage changes");
  expect(result).toContain("Push to remote");
});

test("inline HTML tags are stripped from table cells", () => {
  const md2 = [
    "| Element | Tag |",
    "|---|---|",
    "| Bold | <b>b</b> |",
    "| Italic | <i>i</i> |",
    "| Inserted | <ins>text</ins> |",
    "",
  ].join("\n");
  const result = mdTableToAscii(md2);
  // HTML tags should be stripped, keeping only text content
  expect(result).toContain("b"); // plain "b" after stripping <b> tags
  expect(result).toContain("i"); // plain "i" after stripping <i> tags
  expect(result).toContain("text"); // plain "text" after stripping <ins> tags
  expect(result).not.toContain("<b>");
  expect(result).not.toContain("</b>");
  expect(result).not.toContain("<i>");
});

test("no table -> pass-through unchanged", () => {
  const input = "Just some text, no table here.";
  expect(mdTableToAscii(input)).toBe(input);
});

test("single cell table", () => {
  const md2 = ["| X |", "|---|", "| 1 |", ""].join("\n");
  const result = mdTableToAscii(md2);
  expect(result).toContain("┌");
  expect(result).toContain("X");
  expect(result).toContain("1");
});
