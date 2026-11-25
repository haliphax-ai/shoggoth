// Streaming attachment download with a hard byte budget.
// -------------------------------------------------------------------------------

import { DEFAULT_MAX_ATTACHMENT_BYTES } from "@shoggoth/shared";
import { mkdir, open, unlink } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Download a URL to a file on disk without buffering the whole body in memory;
 * aborts (and unlinks the partial file) once `maxBytes` is exceeded. Throws on
 * failure; @returns the number of bytes written to `destPath`.
 */
export async function downloadFileToDisk(
  url: string,
  destPath: string,
  maxBytes: number = DEFAULT_MAX_ATTACHMENT_BYTES,
): Promise<number> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);

  await mkdir(dirname(destPath), { recursive: true });
  const file = await open(destPath, "w");

  const body = res.body;
  const reader = body?.getReader();
  let failure: { error: unknown } | undefined;
  let total = 0;
  try {
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (total + value.byteLength > maxBytes) {
          throw new Error(`attachment too large (stream exceeded ${maxBytes} bytes)`);
        }
        await file.write(value);
        total += value.byteLength;
      }
    }
  } catch (e) {
    failure = { error: e };
  } finally {
    // Stop pulling from the underlying HTTP stream so the socket is not left
    // draining a body we no longer want; cancel is a no-op once `done`.
    await reader?.cancel().catch(() => undefined);
    await file.close().catch(() => undefined);
  }
  if (failure) {
    // Close before unlinking so platforms that lock open files still clean up.
    await unlink(destPath).catch(() => undefined);
    throw failure.error;
  }
  return total;
}
