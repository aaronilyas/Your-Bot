import { describe, expect, it } from 'vitest';
import { OutputBuffer, incompleteUtf8Tail } from './output.js';

describe('OutputBuffer', () => {
  it('keeps everything under the limit', () => {
    const buffer = new OutputBuffer(100);
    buffer.append(Buffer.from('hello '));
    buffer.append(Buffer.from('world'));
    expect(buffer.snapshot(true)).toEqual({ output: 'hello world', truncated: false });
  });

  it('truncates from the start and flags it', () => {
    const buffer = new OutputBuffer(5);
    buffer.append(Buffer.from('abc'));
    buffer.append(Buffer.from('defgh'));
    expect(buffer.snapshot(true)).toEqual({ output: 'defgh', truncated: true });
    buffer.append(Buffer.from('X'));
    expect(buffer.snapshot(true).output).toBe('efghX');
  });

  it('cuts on a UTF-8 boundary: never starts with a continuation byte', () => {
    for (const unit of ['\u00e9', '\u4e2d', '\u{1f600}']) {
      for (let limit = 1; limit <= 9; limit++) {
        const buffer = new OutputBuffer(limit);
        buffer.append(Buffer.from(unit.repeat(10)));
        const { output, truncated } = buffer.snapshot(true);
        expect(truncated).toBe(true);
        expect(output.includes('\ufffd'), `${unit} limit ${limit}`).toBe(false);
        expect(Buffer.byteLength(output)).toBeLessThanOrEqual(limit);
        expect(output === '' || [...output].every(character => character === unit)).toBe(true);
      }
    }
  });

  it('handles a single chunk larger than the limit and multibyte data split across chunks', () => {
    const buffer = new OutputBuffer(4);
    const bytes = Buffer.from('a\u00e9\u00e9b'); // 61 c3 a9 c3 a9 62
    buffer.append(bytes.subarray(0, 3));
    buffer.append(bytes.subarray(3));
    expect(buffer.snapshot(true)).toEqual({ output: '\u00e9b', truncated: true });
  });

  it('holds back an incomplete trailing sequence until the process ends', () => {
    const buffer = new OutputBuffer(100);
    const bytes = Buffer.from('ok\u4e2d');
    buffer.append(bytes.subarray(0, bytes.length - 1));
    expect(buffer.snapshot(false).output).toBe('ok');
    buffer.append(bytes.subarray(bytes.length - 1));
    expect(buffer.snapshot(false).output).toBe('ok\u4e2d');
    const broken = new OutputBuffer(100);
    broken.append(Buffer.from([0x61, 0xe4]));
    expect(broken.snapshot(false).output).toBe('a');
    expect(broken.snapshot(true).output).toBe('a\ufffd');
  });

  it('zero limit keeps nothing but reports truncation', () => {
    const buffer = new OutputBuffer(0);
    buffer.append(Buffer.from('x'));
    expect(buffer.snapshot(true)).toEqual({ output: '', truncated: true });
  });

  it('incompleteUtf8Tail', () => {
    expect(incompleteUtf8Tail(Buffer.from('abc'))).toBe(0);
    expect(incompleteUtf8Tail(Buffer.from([0x61, 0xf0, 0x9f]))).toBe(2);
    expect(incompleteUtf8Tail(Buffer.from('\u00e9'))).toBe(0);
    expect(incompleteUtf8Tail(Buffer.from([0xff]))).toBe(0);
  });
});
