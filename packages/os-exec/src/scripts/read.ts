import { readFileSync } from "node:fs";

// Subprocess script for the read tool.
// Reads the file at SHOGGOTH_TOOL_READ_PATH as UTF-8 and writes it to stdout.
// Runs as the agent UID/GID so kernel DAC applies to the read.

const path = process.env.SHOGGOTH_TOOL_READ_PATH!;
process.stdout.write(readFileSync(path, "utf8"));
