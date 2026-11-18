/**
 * Agent CLIs Your Bot knows how to find, connect over ACP, update and sign in to.
 * Package names, update commands and install-method rules follow T3 Code's provider maintenance.
 */

/** How the ACP server is started once the CLI is found. */
export type AcpLaunch =
  /** The CLI itself speaks ACP with these arguments. */
  | { via: 'self'; args: readonly string[] }
  /** A separate ACP adapter package run through `npx -y <package>` (needs Node on PATH). */
  | { via: 'npx'; package: string; args?: readonly string[] };

/** Interprets the output of an auth status probe. */
export type AuthProbe = {
  args: readonly string[];
  /** Return true/false when the output is conclusive, undefined otherwise. */
  parse(output: { stdout: string; stderr: string; code: number | null }): boolean | undefined;
};

export interface AgentCliSpec {
  /** Stable id; also the suffix of the provider id created on connect (`agent-<id>`). */
  id: string;
  name: string;
  /** Executable names, most specific first. */
  binaries: readonly string[];
  acp: AcpLaunch;
  /** npm package used for "latest version" lookups and npm/bun/pnpm installs. */
  npmPackage?: string;
  /** Packages that replaced `npmPackage` from a major version on (e.g. OpenCode 2 is `@opencode/cli`). */
  laterNpmPackages?: readonly { fromMajor: number; package: string }[];
  /** Homebrew formula or cask name. */
  brew?: { name: string; cask?: boolean };
  /** mise tool name when it differs from the binary. */
  miseTool?: string;
  /** Command arguments that update a native (self-managed) install. */
  selfUpdate?: readonly string[];
  /** Command arguments that sign the user in; run in a terminal because they are interactive. */
  login: readonly string[];
  auth?: AuthProbe;
  /** Environment variables that carry credentials or config for this agent. Names only. */
  env: readonly string[];
  /** Install hint shown when the CLI is missing. */
  install: string;
  docs: string;
}

const lower = (output: { stdout: string; stderr: string }) => `${output.stdout}\n${output.stderr}`.toLowerCase();

/** "Not logged in" style phrases. Checked before the positive ones. */
const signedOut = (text: string) => /\bnot (logged|signed) in\b|\bunauthenticated\b|\bno (authenticated|credentials)\b|\blogged out\b/.test(text);
const signedIn = (text: string) => /\b(logged|signed) in\b|\bauthenticated\b/.test(text);

function textProbe(output: { stdout: string; stderr: string; code: number | null }): boolean | undefined {
  const text = lower(output);
  if (signedOut(text)) return false;
  if (signedIn(text) && output.code === 0) return true;
  return undefined;
}

export const AGENT_CLIS: readonly AgentCliSpec[] = Object.freeze([
  {
    id: 'claude', name: 'Claude Code', binaries: ['claude'],
    acp: { via: 'npx', package: '@agentclientprotocol/claude-agent-acp' },
    npmPackage: '@anthropic-ai/claude-code', brew: { name: 'claude-code', cask: true },
    selfUpdate: ['update'], login: ['auth', 'login'],
    auth: {
      args: ['auth', 'status'],
      parse(output) {
        try {
          const parsed = JSON.parse(output.stdout) as { loggedIn?: unknown };
          if (typeof parsed.loggedIn === 'boolean') return parsed.loggedIn;
        } catch { /* older builds print text */ }
        return textProbe(output);
      },
    },
    env: ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'AWS_PROFILE', 'AWS_REGION'],
    install: 'npm install -g @anthropic-ai/claude-code', docs: 'https://docs.claude.com/en/docs/claude-code',
  },
  {
    id: 'codex', name: 'Codex', binaries: ['codex'],
    acp: { via: 'npx', package: '@zed-industries/codex-acp' },
    npmPackage: '@openai/codex', brew: { name: 'codex', cask: true },
    selfUpdate: ['update'], login: ['login'],
    auth: { args: ['login', 'status'], parse: textProbe },
    env: ['OPENAI_API_KEY', 'CODEX_HOME', 'OPENAI_BASE_URL'],
    install: 'npm install -g @openai/codex', docs: 'https://github.com/openai/codex',
  },
  {
    id: 'grok', name: 'Grok Build', binaries: ['grok'],
    acp: { via: 'self', args: ['agent', 'stdio'] },
    npmPackage: '@xai-official/grok',
    selfUpdate: ['update'], login: ['login'],
    env: ['XAI_API_KEY'],
    install: 'npm install -g @xai-official/grok', docs: 'https://x.ai/cli',
  },
  {
    id: 'gemini', name: 'Gemini CLI', binaries: ['gemini'],
    acp: { via: 'self', args: ['--experimental-acp'] },
    npmPackage: '@google/gemini-cli', brew: { name: 'gemini-cli' },
    login: [],
    env: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_APPLICATION_CREDENTIALS'],
    install: 'npm install -g @google/gemini-cli', docs: 'https://github.com/google-gemini/gemini-cli',
  },
  {
    id: 'opencode', name: 'OpenCode', binaries: ['opencode'],
    acp: { via: 'self', args: ['acp'] },
    npmPackage: 'opencode-ai', laterNpmPackages: [{ fromMajor: 2, package: '@opencode/cli' }], brew: { name: 'opencode' },
    selfUpdate: ['upgrade'], login: ['auth', 'login'],
    env: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'XAI_API_KEY'],
    install: 'npm install -g opencode-ai', docs: 'https://opencode.ai/docs',
  },
  {
    id: 'cursor', name: 'Cursor Agent', binaries: ['cursor-agent', 'agent'],
    acp: { via: 'self', args: ['acp'] },
    selfUpdate: ['update'], login: ['login'],
    auth: { args: ['status'], parse: textProbe },
    env: ['CURSOR_API_KEY'],
    install: 'curl https://cursor.com/install -fsS | bash', docs: 'https://cursor.com/cli',
  },
  {
    id: 'copilot', name: 'GitHub Copilot CLI', binaries: ['copilot'],
    acp: { via: 'self', args: ['--acp'] },
    npmPackage: '@github/copilot',
    selfUpdate: ['update'], login: ['login'],
    env: ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
    install: 'npm install -g @github/copilot', docs: 'https://docs.github.com/copilot/how-tos/copilot-cli',
  },
  {
    id: 'qwen', name: 'Qwen Code', binaries: ['qwen'],
    acp: { via: 'self', args: ['--acp'] },
    npmPackage: '@qwen-code/qwen-code',
    selfUpdate: ['update'], login: [],
    env: ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL', 'DASHSCOPE_API_KEY'],
    install: 'npm install -g @qwen-code/qwen-code', docs: 'https://github.com/QwenLM/qwen-code',
  },
  {
    id: 'kiro', name: 'Kiro CLI', binaries: ['kiro-cli'],
    acp: { via: 'self', args: ['acp'] },
    login: ['login'],
    auth: {
      args: ['whoami', '--format', 'json'],
      parse(output) {
        try {
          const parsed = JSON.parse(output.stdout) as { account?: unknown };
          if ('account' in parsed) return parsed.account !== null && parsed.account !== undefined;
        } catch { /* fall through */ }
        return textProbe(output);
      },
    },
    env: [],
    install: 'curl -fsSL https://cli.kiro.dev/install | bash', docs: 'https://kiro.dev/docs/cli',
  },
] satisfies AgentCliSpec[]);

/** npm package for the installed version (newest matching rename wins). */
export function npmPackageFor(spec: AgentCliSpec, version?: string): string | undefined {
  const major = version ? Number.parseInt(version, 10) : Number.NaN;
  const later = [...(spec.laterNpmPackages ?? [])].sort((a, b) => b.fromMajor - a.fromMajor).find(entry => major >= entry.fromMajor);
  return later?.package ?? spec.npmPackage;
}

/** Every npm package name the CLI has shipped as. */
export function npmPackagesOf(spec: AgentCliSpec): string[] {
  return [...(spec.laterNpmPackages ?? []).map(entry => entry.package), ...(spec.npmPackage ? [spec.npmPackage] : [])];
}

export function agentSpec(id: string): AgentCliSpec | undefined {
  return AGENT_CLIS.find(spec => spec.id === id);
}

/** Provider id used for an agent connected from the catalog. */
export function providerIdFor(agentId: string): string { return `agent-${agentId}`; }
