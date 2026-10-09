import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
const source = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));
export default defineConfig({
  resolve: { alias: Object.fromEntries(['contracts', 'core', 'adapters', 'executor'].map(name => [`@your-bot/${name}`, source(name)])) },
  test: { include: ['packages/**/*.test.ts', 'tests/**/*.test.ts', 'apps/**/*.test.ts', 'apps/**/*.test.tsx'], testTimeout: 30000 }
});
