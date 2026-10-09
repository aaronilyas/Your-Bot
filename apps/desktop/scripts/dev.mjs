import { createServer } from 'vite';
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import electron from 'electron';
const common = { bundle: true, sourcemap: true, platform: 'node', target: 'node22', external: ['electron'] };
await build({ ...common, format: 'esm', entryPoints: ['src/main/entry.ts', 'src/main/host.ts'], outdir: 'dist/main' });
await build({ ...common, format: 'cjs', entryPoints: ['src/preload/index.ts'], outfile: 'dist/preload/index.cjs' });
const server = await createServer();
await server.listen();
const child = spawn(electron, ['.'], { stdio: 'inherit', env: { ...process.env, YOUR_BOT_RENDERER_URL: 'http://127.0.0.1:5173' } });
let stopping = false;
async function stop() { if (stopping) return; stopping = true; child.kill(); await server.close(); }
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', async code => { await stop(); process.exitCode = code ?? 0; });
