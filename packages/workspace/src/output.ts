/** Number of trailing bytes that form an incomplete (but so far valid) UTF-8 sequence. */
export function incompleteUtf8Tail(buffer: Buffer): number {
  const max = Math.min(3, buffer.length);
  for (let back = 1; back <= max; back++) {
    const byte = buffer[buffer.length - back]!;
    if ((byte & 0xc0) === 0x80) continue; // continuation byte: keep looking for the lead byte
    const needed = byte >= 0xf0 && byte <= 0xf4 ? 4 : byte >= 0xe0 && byte <= 0xef ? 3 : byte >= 0xc2 && byte <= 0xdf ? 2 : 1;
    return needed > back ? back : 0;
  }
  return 0;
}

/**
 * Byte ring buffer: keeps the most recent `limit` bytes. When older data was dropped, the visible
 * text starts on a UTF-8 character boundary and `truncated` is true.
 */
export class OutputBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  private dropped = false;

  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('limit must be a non-negative integer');
  }

  get truncated(): boolean { return this.dropped; }

  append(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.size += chunk.length;
    let excess = this.size - this.limit;
    if (excess <= 0) return;
    this.dropped = true;
    this.size = this.limit;
    while (excess > 0) {
      const first = this.chunks[0]!;
      if (first.length <= excess) { excess -= first.length; this.chunks.shift(); } else { this.chunks[0] = first.subarray(excess); excess = 0; }
    }
  }

  /** `final`: the process has ended, so a dangling partial character is flushed (as U+FFFD) instead of held back. */
  snapshot(final: boolean): { output: string; truncated: boolean } {
    let bytes = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks, this.size);
    if (this.dropped) {
      let skip = 0;
      while (skip < 3 && skip < bytes.length && (bytes[skip]! & 0xc0) === 0x80) skip++;
      if (skip > 0) bytes = bytes.subarray(skip);
    }
    if (!final) {
      const tail = incompleteUtf8Tail(bytes);
      if (tail > 0) bytes = bytes.subarray(0, bytes.length - tail);
    }
    return { output: bytes.toString('utf8'), truncated: this.dropped };
  }

  clear(): void { this.chunks = []; this.size = 0; }
}
