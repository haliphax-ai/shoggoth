import { readFileSync } from "node:fs";

// Subprocess script for the binary read tool.
// Reads the file at SHOGGOTH_TOOL_READ_PATH as raw bytes, base64-encodes them,
// and writes the result to stdout (base64 survives the UTF-8 stdout pipe).

const path = process.env.SHOGGOTH_TOOL_READ_PATH!;
process.stdout.write(readFileSync(path).toString("base64"));
