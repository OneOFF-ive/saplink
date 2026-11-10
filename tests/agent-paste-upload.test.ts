import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../web/agent.js', import.meta.url), 'utf8');
const start = source.indexOf('  function queueUploads(files) {');
const end = source.indexOf("\n  $('#agent-prompt').oninput", start);
assert.ok(start >= 0 && end > start);

type FileStub = { name: string; size: number };
type ClipboardStub = { files: FileStub[]; items: { kind: string; getAsFile: () => FileStub | null }[]; types: string[] };

function fixture() {
  const prompt: { onpaste?: (event: unknown) => void } = {};
  const input: { value: string; onchange?: (event: unknown) => void; click: () => void } = { value: '', click: () => {} };
  const upload = { disabled: false, onclick: undefined };
  const errors: string[] = [];
  const context = vm.createContext({ pendingUploads: [], renderUploads: () => {}, updateControls: () => {},
    toast: (message: string) => errors.push(message),
    $: (selector: string) => selector === '#agent-prompt' ? prompt : selector === '#agent-upload' ? upload : input });
  vm.runInContext(source.slice(start, end), context);
  return { context, errors, upload, input,
    paste: (clipboard: ClipboardStub | null) => {
      let prevented = false;
      prompt.onpaste!({ clipboardData: clipboard, preventDefault: () => { prevented = true; } });
      return prevented;
    } };
}
const file = (name: string, size = 10) => ({ name, size });
const clipboard = (files: FileStub[] = [], items: ClipboardStub['items'] = [], types: string[] = []) => ({ files, items, types });

test('pasting files queues them once and ordinary text keeps native paste behavior', () => {
  const f = fixture();
  assert.equal(f.paste(clipboard([], [], ['text/plain'])), false);
  assert.equal(f.paste(null), false);
  const pasted = file('说明');
  assert.equal(f.paste(clipboard([pasted], [{ kind: 'file', getAsFile: () => pasted }], ['Files'])), true);
  assert.equal(f.context.pendingUploads.length, 1);
  assert.equal(f.context.pendingUploads[0], pasted);
  f.input.onchange!({ target: { files: [file('data.tsv')], value: 'selected' } });
  assert.equal(f.context.pendingUploads.length, 2);
});

test('paste supports file items and explicitly reports unavailable or rejected files', () => {
  const f = fixture();
  assert.equal(f.paste(clipboard([], [{ kind: 'file', getAsFile: () => file('data.json') }], ['Files'])), true);
  assert.equal(f.context.pendingUploads[0].name, 'data.json');
  assert.equal(f.paste(clipboard([], [{ kind: 'file', getAsFile: () => null }], ['Files'])), true);
  assert.match(f.errors.at(-1)!, /无法读取剪贴板/);
  assert.equal(f.paste(clipboard([file('partial.txt')], [
    { kind: 'file', getAsFile: () => file('partial.txt') }, { kind: 'file', getAsFile: () => null }
  ], ['Files'])), true);
  assert.match(f.errors.at(-1)!, /无法读取剪贴板/);
  assert.equal(f.paste(clipboard([], [], ['Files'])), true);
  assert.match(f.errors.at(-1)!, /无法读取剪贴板/);
  assert.equal(f.paste(clipboard([file('x'.repeat(201))], [], ['Files'])), true);
  assert.match(f.errors.at(-1)!, /文件名过长/);
  assert.equal(f.paste(clipboard([file('large.txt', 10 * 1024 * 1024 + 1)], [], ['Files'])), true);
  assert.match(f.errors.at(-1)!, /10 MiB/);
  assert.equal(f.context.pendingUploads.length, 1);
  f.upload.disabled = true;
  assert.equal(f.paste(clipboard([file('next.txt')], [], ['Files'])), true);
  assert.match(f.errors.at(-1)!, /当前无法添加文件/);
  assert.equal(f.context.pendingUploads.length, 1);
});

test('pasting too many files leaves existing attachments unchanged', () => {
  const f = fixture();
  assert.equal(f.paste(clipboard(Array.from({length:10},(_,i)=>file(`file-${i}`)), [], ['Files'])), true);
  assert.equal(f.paste(clipboard([file('extra')], [], ['Files'])), true);
  assert.match(f.errors.at(-1)!, /最多 10 个/);
  assert.equal(f.context.pendingUploads.length, 10);
});

test('images can reach 32 MiB each and 64 MiB combined', () => {
  const f = fixture();
  const image = file('screenshot.png',32*1024*1024);
  f.input.onchange!({target:{files:[image,image],value:'selected'}});
  assert.equal(f.context.pendingUploads.length,2);
  f.input.onchange!({target:{files:[file('extra.txt',1)],value:'selected'}});
  assert.match(f.errors.at(-1)!,/64 MiB/);
  assert.equal(f.context.pendingUploads.length,2);
});
