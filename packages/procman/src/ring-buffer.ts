// ---------------------------------------------------------------------------
// Ring Buffer — Fixed-size circular byte buffer for output capture
// ---------------------------------------------------------------------------

const DEFAULT_MAX_BYTES = 1024 * 1024; // 1 MB

export class RingBuffer {
  private buf: Buffer;
  private readonly max: number;
  /** Next write position. */
  private head = 0;
  /** Total bytes ever written (used to compute readable region). */
  private totalWritten = 0;

  constructor(maxBytes: number = DEFAULT_MAX_BYTES) {
    this.max = maxBytes;
    this.buf = Buffer.alloc(maxBytes);
  }

  /** Number of readable bytes currently in the buffer. */
  get byteLength(): number {
    return Math.min(this.totalWritten, this.max);
  }

  /** Write a chunk into the ring buffer, overwriting oldest data on overflow. */
  write(chunk: Buffer): void {
    if (chunk.length === 0) return;

    if (chunk.length >= this.max) {
      // Chunk larger than buffer — keep only the tail
      chunk.copy(this.buf, 0, chunk.length - this.max);
      this.head = 0;
      this.totalWritten += chunk.length;
      return;
    }

    const spaceToEnd = this.max - this.head;
    if (chunk.length <= spaceToEnd) {
      chunk.copy(this.buf, this.head);
    } else {
      // Wrap around
      chunk.copy(this.buf, this.head, 0, spaceToEnd);
      chunk.copy(this.buf, 0, spaceToEnd);
    }
    this.head = (this.head + chunk.length) % this.max;
    this.totalWritten += chunk.length;
  }

  /** Read all buffered data in chronological order. */
  read(): Buffer {
    const len = this.byteLength;
    if (len === 0) return Buffer.alloc(0);

    if (this.totalWritten <= this.max) {
      // Buffer hasn't wrapped yet — data starts at 0
      return Buffer.from(this.buf.subarray(0, len));
    }

    // Buffer has wrapped — oldest data starts at head
    const result = Buffer.alloc(len);
    const tailLen = this.max - this.head;
    this.buf.copy(result, 0, this.head, this.head + tailLen);
    this.buf.copy(result, tailLen, 0, this.head);
    return result;
  }

  /** Read all buffered data as a UTF-8 string. */
  readString(): string {
    return this.read().toString("utf8");
  }

  /** Clear the buffer. */
  clear(): void {
    this.head = 0;
    this.totalWritten = 0;
  }
}
