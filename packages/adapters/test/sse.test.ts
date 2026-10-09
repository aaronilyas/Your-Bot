import { describe, expect, it } from 'vitest';
import { parseSse } from '../src/index.js';

async function parse(text: string, bytes = 1, limit?: number) {
  const encoded = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    for (let i = 0; i < encoded.length; i += bytes) controller.enqueue(encoded.slice(i, i + bytes));
    controller.close();
  } });
  const result: string[] = [];
  for await (const event of parseSse(body, new AbortController().signal, limit)) result.push(event);
  return result;
}

describe('SSE framing', () => {
  it('handles UTF-8, BOM, fragmented CRLF, lone CR/LF, comments and multiline fields', async () => {
    expect(await parse('\uFEFF: hello\r\nid: 5\r\ndata: 🌍\r\ndata: second\r\n\r\nevent: ignored\ndata: done\n\ndata: final\r\r'))
      .toEqual(['🌍\nsecond', 'done', 'final']);
  });
  it('recognizes empty data and ignores unknown fields', async () => {
    expect(await parse('retry: 5\ndata\n\ndata: \n\n')).toEqual(['', '']);
  });
  it('rejects incomplete events and enforces bounded event buffers', async () => {
    await expect(parse('data: partial\n')).rejects.toMatchObject({ code: 'TRUNCATED_STREAM' });
    await expect(parse('data: too-large\n\n', 1, 8)).rejects.toMatchObject({ code: 'RESPONSE_LIMIT' });
  });
  it('cancels an idle stream on abort', async () => {
    const controller = new AbortController();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const read = (async () => { for await (const _ of parseSse(body, controller.signal)) { /* idle */ } })();
    controller.abort();
    await expect(read).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(cancelled).toBe(true);
  });
});
