// ---------------------------------------------------------------------------
// Min-heap for timer entries, ordered by fire_at ascending.
// ---------------------------------------------------------------------------

export interface TimerEntry {
  readonly id: string;
  readonly sessionId: string;
  readonly label: string;
  readonly fireAt: string; // ISO 8601 UTC
  readonly message: string;
  readonly sessionAnchor?: string | null;
}

/**
 * A min-heap that orders {@link TimerEntry} by `fireAt` ascending (earliest first).
 */
export class TimerHeap {
  private readonly items: TimerEntry[] = [];
  /** Map id → index for O(1) lookup in removeById. */
  private readonly index = new Map<string, number>();

  get size(): number {
    return this.items.length;
  }

  peek(): TimerEntry | undefined {
    return this.items[0];
  }

  insert(entry: TimerEntry): void {
    this.items.push(entry);
    this.index.set(entry.id, this.items.length - 1);
    this.bubbleUp(this.items.length - 1);
  }

  extractMin(): TimerEntry | undefined {
    if (this.items.length === 0) return undefined;
    const min = this.items[0];
    this.index.delete(min.id);
    const last = this.items.pop()!;
    if (this.items.length > 0) {
      this.items[0] = last;
      this.index.set(last.id, 0);
      this.sinkDown(0);
    }
    return min;
  }

  removeById(id: string): TimerEntry | undefined {
    const idx = this.index.get(id);
    if (idx === undefined) return undefined;
    const removed = this.items[idx];
    this.index.delete(id);
    const last = this.items.pop()!;
    if (idx < this.items.length) {
      this.items[idx] = last;
      this.index.set(last.id, idx);
      this.bubbleUp(idx);
      this.sinkDown(this.index.get(last.id)!);
    }
    return removed;
  }

  // ---- internal helpers ----

  private less(a: number, b: number): boolean {
    return this.items[a].fireAt < this.items[b].fireAt;
  }

  private swap(i: number, j: number): void {
    const tmp = this.items[i];
    this.items[i] = this.items[j];
    this.items[j] = tmp;
    this.index.set(this.items[i].id, i);
    this.index.set(this.items[j].id, j);
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.less(i, parent)) {
        this.swap(i, parent);
        i = parent;
      } else {
        break;
      }
    }
  }

  private sinkDown(i: number): void {
    const n = this.items.length;
    while (true) {
      let smallest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < n && this.less(left, smallest)) smallest = left;
      if (right < n && this.less(right, smallest)) smallest = right;
      if (smallest === i) break;
      this.swap(i, smallest);
      i = smallest;
    }
  }
}
