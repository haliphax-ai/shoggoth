import { ModelRequestAbortedError } from "./errors";

type StreamReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;

/**
 * Read the next chunk from an SSE response-body reader with abort support.
 *
 * When `signal` fires mid-stream the underlying reader is **cancelled**
 * (closing the API response stream) and {@link ModelRequestAbortedError} is
 * thrown, instead of the caller waiting for the remainder of the stream to
 * flush. An already-aborted signal cancels the stream before the first read.
 */
export async function readStreamChunkOrAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
): Promise<StreamReadResult> {
  if (signal?.aborted) {
    await cancelReaderQuietly(reader);
    throw new ModelRequestAbortedError();
  }
  if (!signal) return reader.read();

  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        onAbort = () => reject(new ModelRequestAbortedError());
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } catch (err) {
    if (err instanceof ModelRequestAbortedError) {
      // Close the response stream so the connection is released immediately.
      await cancelReaderQuietly(reader);
    }
    throw err;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

async function cancelReaderQuietly(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    /* stream may already be errored/closed */
  }
}
