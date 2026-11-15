import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildCmdCommandLine, cmdExeArguments, quoteBatchArgument, quoteBatchPath } from './winquote.js';
import { cleanupTemp, makeTemp } from './test-support.js';

afterEach(cleanupTemp);

describe('quoteBatchArgument (pure)', () => {
  it('leaves conservative arguments alone', () => {
    for (const plain of ['run', '--flag', 'a/b\\c.txt', 'x:y', 'user@host+tag']) expect(quoteBatchArgument(plain)).toBe(plain);
  });

  it('quotes everything else so cmd metacharacters stay literal', () => {
    expect(quoteBatchArgument('')).toBe('""');
    expect(quoteBatchArgument('a b')).toBe('"a b"');
    expect(quoteBatchArgument('a&b')).toBe('"a&b"');
    expect(quoteBatchArgument('a|b>c<d^e(f)')).toBe('"a|b>c<d^e(f)"');
    expect(quoteBatchArgument('x=y')).toBe('"x=y"');
    expect(quoteBatchArgument('a,b;c')).toBe('"a,b;c"');
  });

  it('doubles quotes and the backslashes in front of them or the closing quote', () => {
    expect(quoteBatchArgument('say "hi"')).toBe('"say ""hi"""');
    expect(quoteBatchArgument('x" & calc & "y')).toBe('"x"" & calc & ""y"');
    expect(quoteBatchArgument('a\\"b')).toBe('"a\\\\""b"');
    expect(quoteBatchArgument('two words\\')).toBe('"two words\\\\"');
    expect(quoteBatchArgument('mid\\dle and')).toBe('"mid\\dle and"');
  });

  it('neutralizes % so %VAR% can not expand', () => {
    expect(quoteBatchArgument('%PATH%')).toBe('"%%cd:~,%PATH%%cd:~,%"');
    expect(quoteBatchArgument('100%')).toBe('"100%%cd:~,%"');
  });

  it('rejects arguments that can not be represented', () => {
    for (const bad of ['a\nb', 'a\rb', 'a\0b']) expect(() => quoteBatchArgument(bad)).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    expect(() => quoteBatchPath('C:\\100%\\x.cmd')).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  });

  it('builds the cmd.exe invocation', () => {
    expect(buildCmdCommandLine('C:\\Program Files\\n\\npm.cmd', ['run', 'a b'])).toBe('""C:\\Program Files\\n\\npm.cmd" run "a b""');
    expect(cmdExeArguments('C:\\x.cmd', [])).toEqual(['/d', '/s', '/v:off', '/c', '""C:\\x.cmd""']);
  });
});

// Real cmd.exe + batch file round trip: nothing is injected and every argument arrives intact.
if (process.platform === 'win32') {
  describe('quoteBatchArgument against real cmd.exe', () => {
    const hostile = [
      'plain', 'a b', '"quoted"', 'a&echo PWNED>marker.txt', '&echo PWNED>marker.txt', 'x" & echo PWNED>marker.txt & "y',
      '%PATH%', '100%', '%cd%', '^', '!x!', 'trail\\', 'trail\\\\', 'a\\"b', '', '(a)', '<a>', 'a|b', "it's", 'x=y', 'a,b;c', '--flag=a b', '\u00fcn\u00ef',
    ];
    it('round-trips hostile arguments through a .cmd forwarding %*', async () => {
      const dir = await makeTemp('ybq-');
      await writeFile(join(dir, 'print.js'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
      const batch = join(dir, 'echo args.cmd');
      await writeFile(batch, `@echo off\r\n"${process.execPath}" "%~dp0print.js" %*\r\n`);
      for (const argument of hostile) {
        const result = spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'), cmdExeArguments(batch, [argument, 'tail']), { cwd: dir, windowsVerbatimArguments: true, encoding: 'utf8' });
        expect(JSON.parse(result.stdout), JSON.stringify(argument)).toEqual([argument, 'tail']);
      }
      expect(existsSync(join(dir, 'marker.txt'))).toBe(false);
    });
  });
}
