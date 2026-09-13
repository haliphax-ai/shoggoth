// ---------------------------------------------------------------------------
// Structured JSON logger — shared across procman modules
// ---------------------------------------------------------------------------

export function log(
  level: string,
  msg: string,
  fields: Record<string, unknown> = {},
): void {
  process.stderr.write(
    JSON.stringify({ level, msg, ...fields, ts: new Date().toISOString() }) + "\n",
  );
}
