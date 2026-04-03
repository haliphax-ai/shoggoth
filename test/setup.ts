import { vi } from "vitest";

// Suppress structured JSON log lines written to stderr during tests
const originalStderrWrite = process.stderr.write.bind(process.stderr);
vi.spyOn(process.stderr, "write").mockImplementation((chunk: any, ...args: any[]) => {
  const str = typeof chunk === "string" ? chunk : chunk.toString();
  if (str.startsWith("{\"ts\":")) return true;
  return (originalStderrWrite as any)(chunk, ...args);
});
