#!/usr/bin/env node
import { runCli } from './cli.js';

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
runCli(process.argv.slice(2), {
  env: process.env,
  stdout: line => process.stdout.write(`${line}\n`),
  stderr: line => process.stderr.write(`${line}\n`),
  signal: controller.signal,
}).then(code => { process.exitCode = code; }, error => { process.stderr.write(`${(error as Error).message}\n`); process.exitCode = 1; });
