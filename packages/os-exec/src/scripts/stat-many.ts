import { readFileSync, lstatSync, statSync, readlinkSync } from "node:fs";

// Batched stat subprocess: JSON array of { path, absPath } on stdin, JSON array of
// per-path stat objects on stdout (same fields as stat.ts); failed paths yield
// { path, error } in-band. Runs as the agent UID/GID so kernel DAC applies per path.

interface BatchRequest {
  path: string;
  absPath: string;
}

function isBatchRequest(v: unknown): v is BatchRequest {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as BatchRequest).path === "string" &&
    typeof (v as BatchRequest).absPath === "string"
  );
}

/** Line-count cap env override, matching stat.ts behavior. */
function lineCountLimit(): number {
  const raw = process.env.SHOGGOTH_TOOL_STAT_LINE_LIMIT;
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : 10 * 1024 * 1024;
}

function statOne(absPath: string): Record<string, unknown> {
  const lst = lstatSync(absPath);
  const isSymlink = lst.isSymbolicLink();
  const st = isSymlink ? statSync(absPath) : lst;

  let type = "other";
  if (st.isFile()) type = "file";
  else if (st.isDirectory()) type = "directory";

  const out: Record<string, unknown> = {
    size: st.size,
    mtime: st.mtime.toISOString(),
    mode: st.mode,
    type,
    isSymlink,
  };

  if (isSymlink) out.target = readlinkSync(absPath);

  // Count lines for small regular files (same cap as stat.ts)
  if (type === "file" && st.size <= lineCountLimit()) {
    try {
      out.lines = readFileSync(absPath, "utf8").split("\n").length - 1;
    } catch {
      // ignore read errors for line counting
    }
  }

  return out;
}

try {
  const raw = readFileSync(0, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("batch request must be a JSON array");
  const requests = parsed.map((entry, i) => {
    if (!isBatchRequest(entry)) throw new Error(`invalid batch request at index ${i}`);
    return entry;
  });

  const results = requests.map(({ path, absPath }) => {
    try {
      return { path, ...statOne(absPath) };
    } catch (e: unknown) {
      return { path, error: (e as Error).message };
    }
  });

  process.stdout.write(JSON.stringify(results));
} catch (e: unknown) {
  process.stderr.write((e as Error).message);
  process.exit(1);
}
