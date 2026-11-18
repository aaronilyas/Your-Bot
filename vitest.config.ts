import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
const desktopVersion = (JSON.parse(readFileSync(new URL('./apps/desktop/package.json', import.meta.url), 'utf8')) as { version: string }).version;
const source = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));
export default defineConfig({
  plugins: [react()],
  // The desktop renderer reads its version from a Vite define; tests need the same constant.
  define: { __APP_VERSION__: JSON.stringify(desktopVersion) },
  resolve: { alias: Object.fromEntries(['contracts', 'core', 'adapters', 'executor', 'workspace', 'mcp', 'remote', 'skills', 'secrets', 'runtime', 'providers'].map(name => [`@your-bot/${name}`, source(name)])) },
  test: { include: ['packages/**/*.test.ts', 'tests/**/*.test.ts', 'apps/**/*.test.ts', 'apps/**/*.test.tsx'], testTimeout: 30000 }
});
