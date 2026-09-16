import { lstatSync, statSync, readlinkSync, readFileSync } from "node:fs";

// Subprocess script that outputs JSON stat info for the path in
// SHOGGOTH_TOOL_STAT_PATH. Runs as the agent UID/GID so kernel DAC applies.

const p = process.env.SHOGGOTH_TOOL_STAT_PATH!;

try {
  const lst = lstatSync(p);
  const isSymlink = lst.isSymbolicLink();
  const st = isSymlink ? statSync(p) : lst;

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

  if (isSymlink) out.target = readlinkSync(p);

  // Count lines for small regular files (10 MB cap)
  if (type === "file" && st.size <= 10 * 1024 * 1024) {
    try {
      out.lines = readFileSync(p, "utf8").split("\n").length - 1;
    } catch {
      // ignore read errors for line counting
    }
  }

  process.stdout.write(JSON.stringify(out));
} catch (e: unknown) {
  process.stdout.write(JSON.stringify({ error: (e as Error).message }));
}
