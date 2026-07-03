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

test("wide table reflows columns to max 20 chars and wraps text", () => {
  const wideMd = [
    "| Feature | Description | Status | Notes |",
    "|---|---|---|---|",
    "| Authentication system overhaul | Migrate from session-based auth to JWT tokens with refresh | In Progress | Requires coordination with the frontend team and mobile apps |",
    "| Database migration tooling | Automated schema migrations with rollback support | Planned | Should integrate with existing CI/CD pipeline |",
    "",
  ].join("\n");
  const result = mdTableToAscii(wideMd);

  const codeMatch = result.match(/```text\n([\s\S]*?)```/);
  expect(codeMatch).toBeTruthy();
  const box = codeMatch![1].trim();
  const lines = box.split("\n");

  // All lines should be the same width (box-drawing consistency)
  const firstLineWidth = lines[0].length;
  for (const line of lines) {
    expect(line.length).toBe(firstLineWidth);
  }

  // Table should be narrower than the uncapped version would be
  // With 4 cols capped at 20: 4*(20+2) + 4 separators + 1 = 93 max
  // But columns narrower than 20 keep their natural width
  expect(firstLineWidth).toBeLessThanOrEqual(93);

  // Content should still be present (wrapped across lines)
  expect(box).toContain("Authentication");
  expect(box).toContain("Planned");

  // Multi-line wrapping: the long descriptions should produce extra visual rows
  // Count data rows (lines starting with │ that aren't separators)
  const dataLines = lines.filter(
    (l) => l.startsWith("│") && !l.includes("├") && !l.includes("┴") && !l.includes("┬"),
  );
  // Original has 1 header + 2 data rows = 3 logical rows, but wrapping adds extra lines
  expect(dataLines.length).toBeGreaterThan(3);
});

test("narrow table does not reflow", () => {
  const narrowMd = ["| A | B |", "|---|---|", "| 1 | 2 |", "| 3 | 4 |", ""].join("\n");
  const result = mdTableToAscii(narrowMd);
  const codeMatch = result.match(/```text\n([\s\S]*?)```/);
  expect(codeMatch).toBeTruthy();
  const box = codeMatch![1].trim();
  const lines = box.split("\n");

  // Narrow table: no wrapping, so data lines = header + 2 rows = 3
  const dataLines = lines.filter(
    (l) => l.startsWith("│") && !l.includes("├") && !l.includes("┴") && !l.includes("┬"),
  );
  expect(dataLines.length).toBe(3);
});

test("wide 2-column table distributes width evenly up to 80 chars", () => {
  const md2col = [
    "| Tool | Description |",
    "|---|---|",
    "| builtin-search-replace | Search for patterns in files using ripgrep and replace them with support for regex |",
    "| builtin-workflow | Orchestrate parallel and sequential subagent workflows with dependency graphs |",
    "",
  ].join("\n");
  const result = mdTableToAscii(md2col);
  const codeMatch = result.match(/```text\n([\s\S]*?)```/);
  expect(codeMatch).toBeTruthy();
  const box = codeMatch![1].trim();
  const lines = box.split("\n");

  // With 2 columns, even cap = floor((80 - 7) / 2) = 36
  // So columns should be wider than 20, filling the budget
  const lineWidth = lines[0].length;
  // Table should be wider than if we used 20-char caps: 2*(20+2) + 2 + 1 = 47
  expect(lineWidth).toBeGreaterThan(47);
  // But should not exceed 80
  expect(lineWidth).toBeLessThanOrEqual(80);
});

test("narrow columns keep natural width, wide columns get remaining budget", () => {
  // "OK" and "Yes" are narrow; the description column is very wide.
  // The narrow columns should stay at their natural width, and the wide
  // column should get the leftover budget rather than being capped at 20.
  const mdMixed = [
    "| Status | Enabled | Description |",
    "|---|---|---|",
    "| OK | Yes | This is a very long description that should wrap but get more than twenty characters of width because the other columns are small |",
    "| Err | No | Another lengthy explanation that benefits from the extra space freed by narrow siblings |",
    "",
  ].join("\n");
  const result = mdTableToAscii(mdMixed);
  const codeMatch = result.match(/```text\n([\s\S]*?)```/);
  expect(codeMatch).toBeTruthy();
  const box = codeMatch![1].trim();
  const lines = box.split("\n");

  const lineWidth = lines[0].length;
  // Should use close to 80 chars total (narrow cols lock in, wide col expands)
  expect(lineWidth).toBeLessThanOrEqual(80);
  // The wide column should be wider than 20 since narrow cols free up budget
  // Overhead for 3 cols: 3*3+1 = 10. "Status"=3, "Enabled"=7 → locked = 10.
  // Remaining = 80 - 10 - 3 - 7 = 60 for the description column.
  // So the table should be much wider than a naive 3*20 + 10 = 70 layout.
  expect(lineWidth).toBeGreaterThan(70);
});

test("words wider than their column are hard-broken when column is narrower than 20 chars", () => {
  // Simulate the real-world bug: a path like "projects/shoggoth/package.json" (30 chars)
  // in a table with 3 columns where the dynamic cap is well below 20.
  const mdPaths = [
    "| Test | Expected | Actual |",
    "|---|---|---|",
    "| 1. stat projects/shoggoth/package.json from workspace root | success | success |",
    "| 2. stat package.json from workdir | success | ENOENT |",
    "",
  ].join("\n");
  const result = mdTableToAscii(mdPaths);
  const codeMatch = result.match(/```text\n([\s\S]*?)```/);
  expect(codeMatch).toBeTruthy();
  const box = codeMatch![1].trim();
  const lines = box.split("\n");

  // All lines must be the same width (no overflow past the box border)
  const firstLineWidth = lines[0].length;
  for (const line of lines) {
    expect(line.length).toBe(firstLineWidth);
  }

  // Table must fit within 80 chars
  expect(firstLineWidth).toBeLessThanOrEqual(80);

  // The long path should be broken across lines (not left as one oversized cell)
  // Count data lines for the first data row — should be > 1 due to wrapping
  const sepIndex = lines.findIndex((l) => l.startsWith("├"));
  const dataLinesAfterSep = lines
    .slice(sepIndex + 1)
    .filter((l) => l.startsWith("│") && !l.includes("├") && !l.includes("└"));
  // 2 logical rows, but the first has a long path that must wrap → more visual lines
  expect(dataLinesAfterSep.length).toBeGreaterThan(2);
});

test("wide table adds row separator lines between every row when reflowing", () => {
  const wideMd = [
    "| Feature | Description | Status | Notes |",
    "|---|---|---|---|",
    "| Auth overhaul | Migrate from session-based auth to JWT tokens with refresh | In Progress | Requires coordination with the frontend team and mobile apps |",
    "| DB migration tooling | Automated schema migrations with rollback support | Planned | Should integrate with existing CI/CD pipeline |",
    "| Logging pipeline | Centralized structured logging with retention policies | Done | Deployed to production last week |",
    "",
  ].join("\n");
  const result = mdTableToAscii(wideMd);

  const codeMatch = result.match(/```text\n([\s\S]*?)```/);
  expect(codeMatch).toBeTruthy();
  const box = codeMatch![1].trim();
  const lines = box.split("\n");
  // Count separator rows (lines starting with ├)
  const sepLines = lines.filter((l) => l.startsWith("├"));
  // Header-sep + sep-after-row1 + sep-after-row2 = 3 (no sep after last row)
  expect(sepLines.length).toBe(3);

  // Verify structure: top, header, sep, [row lines], sep, ... sep, bottom
  expect(lines[0]).toMatch(/^┌/);
  expect(lines[lines.length - 1]).toMatch(/^└/);
  // First separator is right after the header row
  expect(lines[1]).toMatch(/^│.*Feature/);
  expect(lines[2]).toMatch(/^├/);
});

test("narrow table does NOT add row separators between data rows", () => {
  const narrowMd = ["| A | B | C |", "|---|---|---|", "| 1 | 2 | 3 |", "| 4 | 5 | 6 |", ""].join(
    "\n",
  );
  const result = mdTableToAscii(narrowMd);

  const codeMatch = result.match(/```text\n([\s\S]*?)```/);
  expect(codeMatch).toBeTruthy();
  const box = codeMatch![1].trim();
  const lines = box.split("\n");

  // Narrow table: only 1 separator (header/data divider)
  const sepLines = lines.filter((l) => l.startsWith("├"));
  expect(sepLines.length).toBe(1);

  // Structure: top, header, sep, row1, row2, bottom = 6 lines
  expect(lines.length).toBe(6);
});
