// Keeps itself and a grandchild alive until the process group or tree is killed.
import { spawn } from 'node:child_process';

process.on('SIGTERM', () => {});
const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)'], {
  stdio: 'ignore', windowsHide: true,
});
process.stdout.write(JSON.stringify({ self: process.pid, child: child.pid }) + '\n');
setInterval(() => {}, 1000);
