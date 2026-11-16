import { describe, expect, it } from 'vitest';
import { PLAYWRIGHT_MCP_VERSION, buildChildEnv, expandPreset, planSpawn } from './index.js';

describe('expandPreset', () => {
  it('expands the browser preset to the pinned headless isolated Playwright MCP (stdio, no shell string)', () => {
    const expanded = expandPreset({ id: 'browser', name: 'Browser', enabled: true, preset: 'browser', transport: 'http', url: 'https://example.invalid' });
    expect(expanded).toEqual({
      id: 'browser', name: 'Browser', enabled: true, preset: 'browser', transport: 'stdio', command: 'npx',
      args: ['-y', `@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`, '--headless', '--isolated']
    });
    expect(PLAYWRIGHT_MCP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('keeps env/cwd of an existing stdio config, ignores its command/args, and is idempotent', () => {
    const input = { id: 'b', name: 'B', enabled: true, preset: 'browser' as const, transport: 'stdio' as const, command: 'evil', args: ['--allow-unrestricted-file-access'], env: { K: 'v' }, cwd: '/tmp' };
    const expanded = expandPreset(input);
    expect(expanded).toMatchObject({ command: 'npx', env: { K: 'v' }, cwd: '/tmp' });
    expect((expanded as { args: string[] }).args).not.toContain('--allow-unrestricted-file-access');
    expect(expandPreset(expanded)).toEqual(expanded);
  });

  it('returns configs without a preset unchanged', () => {
    const config = { id: 'x', name: 'X', enabled: true, transport: 'stdio' as const, command: 'node' };
    expect(expandPreset(config)).toBe(config);
  });
});

describe('planSpawn (Windows resolution, platform-simulated)', () => {
  const env = { PATH: 'C:\\Tools;C:\\nodejs', PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: 'C:\\Windows\\System32\\cmd.exe' };
  const files = (...present: string[]) => (candidate: string) => present.includes(candidate);

  it('passes the command through unchanged on posix', () => {
    expect(planSpawn('npx', ['-y', 'x'], { platform: 'linux', env })).toEqual({ command: 'npx', args: ['-y', 'x'], windowsVerbatimArguments: false });
  });

  it('runs .exe directly using PATH + PATHEXT', () => {
    const plan = planSpawn('node', ['a.js'], { platform: 'win32', env, isFile: files('C:\\nodejs\\node.EXE'.replace('EXE', 'exe')) });
    expect(plan).toEqual({ command: 'C:\\nodejs\\node.exe', args: ['a.js'], windowsVerbatimArguments: false });
  });

  it('wraps .cmd shims (npx) through cmd.exe /d /s /c with quoted arguments, never a shell string from user input', () => {
    const plan = planSpawn('npx', ['-y', '@playwright/mcp@1.0.0', '--headless'], { platform: 'win32', env, isFile: files('C:\\nodejs\\npx.cmd') });
    expect(plan.command).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(plan.windowsVerbatimArguments).toBe(true);
    expect(plan.args).toEqual(['/d', '/s', '/c', '""C:\\nodejs\\npx.cmd" "-y" "@playwright/mcp@1.0.0" "--headless""']);
  });

  it('refuses cmd-metacharacter injection in .cmd arguments', () => {
    for (const bad of ['a" & calc & "', '%PATH%', 'a\nb']) {
      expect(() => planSpawn('npx', [bad], { platform: 'win32', env, isFile: files('C:\\nodejs\\npx.cmd') })).toThrow(/not supported/);
    }
  });

  it('reports a missing command as ENOENT and refuses unknown executable types', () => {
    expect(() => planSpawn('nope', [], { platform: 'win32', env, isFile: files() })).toThrow(/not found/);
    expect(() => planSpawn('C:\\x\\tool.ps1', [], { platform: 'win32', env: { ...env, PATHEXT: '.PS1' }, isFile: files('C:\\x\\tool.ps1') })).toThrow(/Unsupported/);
  });
});

describe('buildChildEnv', () => {
  it('drops everything outside the allowlist and lets explicit env win', () => {
    const env = buildChildEnv({ PATH: '/bin', HOME: '/h', OPENAI_API_KEY: 'sk-secret', npm_config_cache: '/c' }, { HOME: '/override', EXTRA: '1' }, 'linux');
    expect(env).toEqual({ PATH: '/bin', HOME: '/override', npm_config_cache: '/c', EXTRA: '1' });
  });
});
