import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { previewEnvironment, previewRuntimeEnvironment } from './dev-environment.mjs';

try {
  const env = await previewRuntimeEnvironment(await previewEnvironment());
  const compiled = process.argv[2] === '--compiled';
  const entry = compiled ? ['../dist/cli.js'] : ['--import', 'tsx', '../src/cli.ts'];
  entry[entry.length - 1] = fileURLToPath(new URL(entry[entry.length - 1], import.meta.url));
  const child = spawn(process.execPath, [...entry, ...process.argv.slice(compiled ? 3 : 2)],
    { env, stdio: 'inherit' });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
