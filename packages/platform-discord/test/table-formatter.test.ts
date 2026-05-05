import { test, expect } from "vitest";
import { mdTableToAscii } from "../src/table-formatter";

const md = `| Planet | Diameter (km) | Moons | Type |
|---|---|---|---|
| Mercury | 4,879 | 0 | Rocky |
| Venus | 12,104 | 0 | Rocky |
| Earth | 12,756 | 1 | Rocky |
| Mars | 6,792 | 2 | Rocky |
| Jupiter | 142,984 | 95 | Gas Giant |
`;

test("renders Markdown table as Unicode box-drawing code block", () => {
  const result = mdTableToAscii(md);

  // Should be wrapped in a fenced code block
  expect(result).toContain("```text");
  expect(result).toContain("```");

  // Extract the code block content
  const codeMatch = result.match(/```text\n([\s\S]*?)```/);
  expect(codeMatch).toBeTruthy();
  const box = codeMatch![1].trim();

  // Should have proper box-drawing characters
  expect(box).toContain("┌");
  expect(box).toContain("┬");
  expect(box).toContain("├");
  expect(box).toContain("┼");
  expect(box).toContain("─");
  expect(box).toContain("│");

  const lines = box.split("\n");
  expect(lines[0]).toMatch(/^┌.*┐$/);
  expect(lines[lines.length - 1]).toMatch(/^└.*┘$/);

  // No empty header row — first data row should be Mercury
  expect(box).toContain("Mercury");
  // Should have exactly 5 data rows (header + 5 planets = 6 total rows)
  const dataLines = lines.filter(
    (l) => l.startsWith("│") && !l.includes("├") && !l.includes("┴") && !l.includes("┬"),
  );
  expect(dataLines.length).toBe(6);

  console.log("--- box output ---");
  console.log(box);
  console.log("--- end ---");
});

test("no table → pass-through unchanged", () => {
  const input = "Just some text, no table here.";
  expect(mdTableToAscii(input)).toBe(input);
});

test("single cell table", () => {
  const md2 = `| X |
|---|
| 1 |
`;
  const result = mdTableToAscii(md2);
  expect(result).toContain("┌");
  expect(result).toContain("X");
  expect(result).toContain("1");
});
