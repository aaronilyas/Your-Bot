import { build as bundle } from 'esbuild';
import { build as viteBuild } from 'vite';
import { execFileSync } from 'node:child_process';
import { copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
await viteBuild();
const common = { bundle: true, sourcemap: true, platform: 'node', target: 'node22', external: ['electron'], format: 'esm' };
// Bundled CommonJS dependencies (e.g. ws) call require() for Node built-ins; ESM output needs a real require.
const esmRequire = { js: "import { createRequire as __yourBotCreateRequire } from 'node:module'; const require = __yourBotCreateRequire(import.meta.url);" };
await bundle({ ...common, banner: esmRequire, entryPoints: ['src/main/entry.ts', 'src/main/host.ts'], outdir: 'dist/main' });
await bundle({ ...common, format: 'cjs', entryPoints: ['src/preload/index.ts'], outfile: 'dist/preload/index.cjs' });
await bundle({ bundle: true, sourcemap: true, platform: 'browser', target: 'es2022', format: 'esm', external: ['react', 'react-dom', 'react/jsx-runtime'], entryPoints: ['src/renderer/index.ts'], outfile: 'dist/renderer-api.js' });
await bundle({ bundle: true, platform: 'browser', target: 'es2022', format: 'esm', entryPoints: ['src/mock/transport.ts'], outfile: 'dist/mock.js' });
// Run tsc through Node itself: spawning `npx` fails on Windows, where it is a .cmd shim.
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
execFileSync(process.execPath, [tsc, '-p', 'tsconfig.json', '--emitDeclarationOnly'], { stdio: 'inherit' });
await copyFile('src/renderer/styles.css', 'dist/styles.css');
await copyFile('src/renderer/theme.css', 'dist/theme.css');
