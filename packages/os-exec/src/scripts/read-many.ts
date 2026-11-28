import { readFileSync } from "node:fs";

// Batched read subprocess: JSON array of { path, absPath } on stdin, JSON array of
// per-path { path, content } or { path, error } results on stdout (one bad path
// never fails the batch). Runs as the agent UID/GID so kernel DAC applies per path.

interface BatchRequest {
  path: string;
  absPath: string;
}

interface BatchResult {
  path: string;
  content?: string;
  error?: string;
}

function isBatchRequest(v: unknown): v is BatchRequest {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as BatchRequest).path === "string" &&
    typeof (v as BatchRequest).absPath === "string"
  );
}

try {
  const raw = readFileSync(0, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("batch request must be a JSON array");
  const requests = parsed.map((entry, i) => {
    if (!isBatchRequest(entry)) throw new Error(`invalid batch request at index ${i}`);
    return entry;
  });

  const results: BatchResult[] = requests.map(({ path, absPath }) => {
    try {
      return { path, content: readFileSync(absPath, "utf8") };
    } catch (e: unknown) {
      return { path, error: `${absPath}: ${(e as Error).message}` };
    }
  });

  process.stdout.write(JSON.stringify(results));
} catch (e: unknown) {
  process.stderr.write((e as Error).message);
  process.exit(1);
}
