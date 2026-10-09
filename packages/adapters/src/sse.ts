import { AdapterError } from './errors.js';
import { throwIfAborted } from './lifecycle.js';

/** Incremental SSE framing: UTF-8, CR/LF/CRLF, comments, multiline data, arbitrary chunks. */
export async function* parseSse(
  body: ReadableStream<Uint8Array>, signal: AbortSignal,
  maxEventBytes = 1_048_576, maxStreamBytes = 16_777_216,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let line = '';
  let data: string[] = [];
  let eventBytes = 0;
  let streamBytes = 0;
  let afterCr = false;
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', onAbort, { once: true });
  const finishLine = (): string | undefined => {
    const current = line;
    line = '';
    if (current === '') {
      const event = data.length ? data.join('\n') : undefined;
      data = [];
      eventBytes = 0;
      return event;
    }
    if (current.startsWith('data:') || current === 'data') {
      let value = current.slice(5);
      if (value.startsWith(' ')) value = value.slice(1);
      data.push(value);
    }
    return undefined;
  };
  try {
    while (true) {
      throwIfAborted(signal);
      const chunk = await reader.read();
      throwIfAborted(signal);
      streamBytes += chunk.value?.byteLength ?? 0;
      if (streamBytes > maxStreamBytes) throw new AdapterError('RESPONSE_LIMIT', 'Provider stream exceeded the size limit.');
      const text = decoder.decode(chunk.value, { stream: !chunk.done });
      for (const char of text) {
        if (afterCr && char === '\n') { afterCr = false; continue; }
        afterCr = false;
        eventBytes += Buffer.byteLength(char);
        if (eventBytes > maxEventBytes) throw new AdapterError('RESPONSE_LIMIT', 'Provider event exceeded the size limit.');
        if (char === '\r' || char === '\n') {
          const event = finishLine();
          afterCr = char === '\r';
          if (event !== undefined) yield event;
        } else line += char;
      }
      if (chunk.done) {
        // SSE only dispatches events with a blank line. Never accept truncated JSON at EOF.
        if (line || data.length) throw new AdapterError('TRUNCATED_STREAM', 'Provider stream ended inside an event.', true);
        break;
      }
    }
  } catch (error) {
    throwIfAborted(signal);
    if (error instanceof AdapterError) throw error;
    throw new AdapterError('INVALID_RESPONSE', 'Provider returned an invalid stream.');
  } finally {
    signal.removeEventListener('abort', onAbort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
