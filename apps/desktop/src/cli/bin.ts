#!/usr/bin/env node
import { runCli } from '@your-bot/host';

// `your-bot providers list | head` closes stdout early; that is not an error.
process.stdout.on('error', error => { if ((error as NodeJS.ErrnoException).code === 'EPIPE') process.exit(0); throw error; });
process.env.YOUR_BOT_CLI_NAME ??= 'your-bot';
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
runCli(process.argv.slice(2), {
  env: process.env,
  stdout: line => process.stdout.write(`${line}\n`),
  stderr: line => process.stderr.write(`${line}\n`),
  write: text => process.stdout.write(text),
  signal: controller.signal,
}).then(code => { process.exitCode = code; }, error => {
  process.stderr.write(`${error instanceof Error ? error.message : 'your-bot failed'}\n`);
  process.exitCode = 1;
});
