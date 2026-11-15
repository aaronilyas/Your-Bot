import { describe, expect, it } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceHost, isShellLine } from './index.js';

describe('shell command lines', () => {
  it('classifies args-less lines with whitespace or shell syntax', () => {
    expect(isShellLine('ls', [])).toBe(false);
    expect(isShellLine('ls -la', [])).toBe(true);
    expect(isShellLine('ls', ['-la'])).toBe(false);
    expect(isShellLine('echo a&&echo b', [])).toBe(true);
  });
  it('runs a shell line through the platform shell inside the workspace', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'yb-shell-')));
    const host = createWorkspaceHost();
    try {
      const id = await host.createTerminal(root, { command: 'echo first&& echo second', cwd: root }, { taskId: 't', signal: new AbortController().signal });
      const status = await host.waitForTerminalExit(id, new AbortController().signal);
      expect(status.exitCode).toBe(0);
      const { output } = await host.terminalOutput(id);
      expect(output.replace(/\r/g, '')).toMatch(/first\s*\nsecond/);
    } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
  });
});
