import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Subprocess script for the extended write tool.
//
// Reads content from stdin, then performs the operation indicated by env vars:
//   SHOGGOTH_TOOL_WRITE_MODE=overwrite — write stdin to file (with optional mkdirp)
//   SHOGGOTH_TOOL_WRITE_MODE=append    — append stdin to file (with optional mkdirp)
//   SHOGGOTH_TOOL_WRITE_MODE=replace   — replace lines START..END with stdin content
//   SHOGGOTH_TOOL_WRITE_MODE=insert    — insert stdin content after line AFTER
//
// Outputs JSON to stdout: { bytesWritten, dirCreated }

const filePath = process.env.SHOGGOTH_TOOL_WRITE_PATH!;
const mode = process.env.SHOGGOTH_TOOL_WRITE_MODE ?? "overwrite";
const mkdirp = process.env.SHOGGOTH_TOOL_WRITE_MKDIRP !== "0";

const content = readFileSync(0, "utf8");

let bytesWritten = 0;
let dirCreated = false;

function ensureDir(fp: string): void {
  const dir = dirname(fp);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    dirCreated = true;
  }
}

function readExisting(): string {
  const existing = readFileSync(filePath, "utf8");
  // Binary check: NUL in first 8KB
  if (existing.slice(0, 8192).includes("\0")) {
    process.stderr.write("cannot perform line-range operation on binary file");
    process.exit(1);
  }
  return existing;
}

function parseLineNumber(envVar: string, label: string): number {
  const val = parseInt(process.env[envVar]!, 10);
  if (isNaN(val)) {
    process.stderr.write(`${label} is not a valid number`);
    process.exit(1);
  }
  return val;
}

try {
  switch (mode) {
    case "overwrite": {
      if (mkdirp) ensureDir(filePath);
      writeFileSync(filePath, content);
      bytesWritten = Buffer.byteLength(content, "utf8");
      break;
    }
    case "append": {
      if (mkdirp) ensureDir(filePath);
      appendFileSync(filePath, content);
      bytesWritten = Buffer.byteLength(content, "utf8");
      break;
    }
    case "replace": {
      if (!existsSync(filePath)) {
        process.stderr.write(`file does not exist: ${filePath}`);
        process.exit(1);
      }
      const startLine = parseLineNumber("SHOGGOTH_TOOL_WRITE_START", "startLine");
      const endLine = parseLineNumber("SHOGGOTH_TOOL_WRITE_END", "endLine");
      const existing = readExisting();
      const lines = existing.split("\n");
      const totalLines = lines.length;
      if (startLine < 1 || startLine > totalLines) {
        process.stderr.write(
          `startLine ${startLine} is out of range (file has ${totalLines} lines)`,
        );
        process.exit(1);
      }
      if (endLine < startLine || endLine > totalLines) {
        process.stderr.write(
          `endLine ${endLine} is out of range (file has ${totalLines} lines, startLine is ${startLine})`,
        );
        process.exit(1);
      }
      const newLines = content.length === 0 ? [] : content.split("\n");
      lines.splice(startLine - 1, endLine - startLine + 1, ...newLines);
      const result = lines.join("\n");
      writeFileSync(filePath, result);
      bytesWritten = Buffer.byteLength(result, "utf8");
      break;
    }
    case "insert": {
      if (!existsSync(filePath)) {
        process.stderr.write(`file does not exist: ${filePath}`);
        process.exit(1);
      }
      const afterLine = parseLineNumber("SHOGGOTH_TOOL_WRITE_AFTER", "insertAfter");
      const existing = readExisting();
      const lines = existing.split("\n");
      const totalLines = lines.length;
      if (afterLine < 0 || afterLine > totalLines) {
        process.stderr.write(
          `insertAfter ${afterLine} is out of range (file has ${totalLines} lines)`,
        );
        process.exit(1);
      }
      const newLines = content.split("\n");
      lines.splice(afterLine, 0, ...newLines);
      const result = lines.join("\n");
      writeFileSync(filePath, result);
      bytesWritten = Buffer.byteLength(result, "utf8");
      break;
    }
    default:
      process.stderr.write(`unknown write mode: ${mode}`);
      process.exit(1);
  }

  process.stdout.write(JSON.stringify({ bytesWritten, dirCreated }));
} catch (e: unknown) {
  process.stderr.write((e as Error).message);
  process.exit(1);
}
