import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConfigStore, type Credentials } from '../src/config.js';
import { describeSapTool, readSapInput, reserveCliWrite, runSapOperation, validateSapInput } from '../src/sap-cli.js';
import { toolSchemas, type ToolName } from '../src/tool-definitions.js';
import { acquireLease, inspectLease } from '../src/lease.js';

const execute = promisify(execFile);
const noCredentials: Credentials = {
  get: async () => { throw new Error('Unexpected credential access'); },
  set: async () => {}, remove: async () => {}
};

async function fixture() {
  const root = resolve('.saplink/tests');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'sap-cli-'));
  return { directory, store: new ConfigStore(directory),
    env: { ...process.env, SAPLINK_CONFIG_DIR: directory, SAPLINK_LOG_DIR: join(directory, 'logs'), SAPLINK_AUTO_UPDATE_CHECK: '0' },
    cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('direct CLI discovers the complete shared tool catalog without MCP, tokens or credentials', async () => {
  const f = await fixture();
  try {
    const run = (...args: string[]) => execute(process.execPath, [resolve('dist/cli.js'), ...args, '--json'], { env: f.env });
    const list = JSON.parse((await run('tools', 'list')).stdout);
    assert.deepEqual(list.data.map((tool: { name: string }) => tool.name).sort(), Object.keys(toolSchemas).sort());
    const instructions = JSON.parse((await run('tools', 'instructions')).stdout).data.instructions;
    assert.match(instructions, /rejects every reuse/);
    assert.doesNotMatch(instructions, /structuredContent|retrieve that operation result in the same process/);
    for (const name of Object.keys(toolSchemas) as ToolName[]) {
      const description = describeSapTool(name);
      assert.equal(description.input_schema.type, 'object');
      assert.ok(description.description);
    }
    const connections = await run('sap', 'list_connections');
    assert.equal(connections.stderr, '');
    assert.equal(JSON.parse(connections.stdout).status, 'success');
    assert.deepEqual(JSON.parse(connections.stdout).data.data, []);
    assert.equal((await inspectLease(f.directory)).state, 'missing');
    assert.equal(describeSapTool('update_source').write, true);
    assert.throws(() => describeSapTool('__proto__'), /Unknown SAP operation/);
  } finally { await f.cleanup(); }
});

test('CLI validates strict shared schemas, defaults, connection conflicts and private input', async () => {
  const connection = randomUUID();
  const input = validateSapInput('query_table', { table_name: 'MARA' }, connection);
  assert.equal(input.connection_id, connection);
  assert.equal(input.limit, 100);
  assert.throws(() => validateSapInput('query_table', { table_name: 'MARA', password: 'SECRET' }, connection), error => {
    assert.ok(error instanceof Error); assert.doesNotMatch(error.message, /SECRET/); return true;
  });
  assert.throws(() => validateSapInput('query_table', { connection_id: randomUUID(), table_name: 'MARA' }, connection), /conflicts/);
  assert.throws(() => validateSapInput('query_table', [], connection), /JSON object/);
  assert.throws(() => validateSapInput('query_table', { table_name: 'MARA', limit: 501 }, connection));
});

test('direct CLI reads UTF-8 input files, rejects invalid or oversized input without echoing contents', async () => {
  const f = await fixture();
  try {
    const path = join(f.directory, 'input.json');
    await writeFile(path, '\uFEFF{"table_name":"MARA"}');
    assert.deepEqual(await readSapInput(path), { table_name: 'MARA' });
    await writeFile(path, 'SECRET malformed');
    await assert.rejects(readSapInput(path), /one valid JSON object/);
    await writeFile(path, ' '.repeat(2 * 1024 * 1024 + 1));
    await assert.rejects(readSapInput(path), /2 MiB/);
  } finally { await f.cleanup(); }
});

test('CLI reservations block concurrent and subsequent writes across tools without storing source', async () => {
  const f = await fixture();
  try {
    const input = { connection_id: randomUUID(), request_id: 'one-intent', source: 'PRIVATE SOURCE' };
    const results = await Promise.allSettled([reserveCliWrite(f.directory, 'update_source', input), reserveCliWrite(f.directory, 'update_source', input)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    await assert.rejects(reserveCliWrite(f.directory, 'activate_objects', input), /already reserved/);
    const folder = join(f.directory, 'cli-write-requests');
    const files = await readdir(folder);
    assert.equal(files.length, 1);
    assert.doesNotMatch(await readFile(join(folder, files[0]), 'utf8'), /PRIVATE SOURCE/);
  } finally { await f.cleanup(); }
});

test('direct operations coexist with the MCP runtime lease and close sessions after failed writes', async () => {
  const f = await fixture();
  const releaseRuntime = await acquireLease(f.directory, 'runtime.lock');
  let calls = 0; let closed = 0;
  const input = { connection_id: randomUUID(), request_id: 'write-1' };
  const make = () => ({ run: async () => { calls++; throw new Error('Simulated interrupted write'); }, close: async () => { closed++; } });
  try {
    await assert.rejects(runSapOperation(f.store, noCredentials, 'update_source', input, make), /interrupted write/);
    assert.equal(calls, 1); assert.equal(closed, 1);
    assert.equal((await inspectLease(f.directory, 'config.lock')).state, 'missing');
    await assert.rejects(runSapOperation(f.store, noCredentials, 'update_source', input, make), /already reserved/);
    assert.equal(calls, 1);
    const read = await runSapOperation(f.store, noCredentials, 'list_connections', {}, () => ({
      run: async () => ({ operation_id: randomUUID(), status: 'success', completed_steps: [], data: [] }), close: async () => {}
    }));
    assert.equal(read.status, 'success');
  } finally { await releaseRuntime(); await f.cleanup(); }
});

test('CLI exits nonzero and preserves operation errors without requiring an MCP server', async () => {
  const f = await fixture();
  try {
    await assert.rejects(execute(process.execPath, [resolve('dist/cli.js'), 'sap', 'get_capabilities', '--connection', randomUUID(), '--timeout-ms', '60000', '--json'], { env: f.env }), error => {
      const result = error as Error & { code: number; stdout: string; stderr: string };
      assert.equal(result.code, 1); assert.equal(result.stderr, '');
      const body = JSON.parse(result.stdout);
      assert.equal(body.status, 'error');
      assert.equal(body.data.error.code, 'CONNECTION_NOT_FOUND');
      assert.ok(body.data.operation_id);
      assert.deepEqual(body.data.completed_steps, []);
      return true;
    });
  } finally { await f.cleanup(); }
});
