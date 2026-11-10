import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../web/agent.js', import.meta.url), 'utf8');
const start = source.indexOf("  $('#agent-prompt').onkeydown = event => {");
const end = source.indexOf("\n  for (const button", start);
assert.ok(start >= 0 && end > start, 'prompt keyboard handler must exist');

function keyboard() {
  let clicks = 0;
  const prompt: { onkeydown?: (event: unknown) => void } = {};
  const send = { disabled: false, click: () => { clicks++; } };
  vm.runInNewContext(source.slice(start, end), {
    $: (selector: string) => selector === '#agent-prompt' ? prompt : send
  });
  return {
    send,
    clicks: () => clicks,
    press: (overrides: Record<string, unknown> = {}) => {
      let prevented = false;
      prompt.onkeydown!({ key: 'Enter', preventDefault: () => { prevented = true; }, ...overrides });
      return prevented;
    }
  };
}

test('Enter sends once only when sending is enabled', () => {
  const input = keyboard();
  assert.equal(input.press(), true);
  assert.equal(input.clicks(), 1);
  assert.equal(input.press({ repeat: true }), true);
  input.send.disabled = true;
  assert.equal(input.press(), true);
  assert.equal(input.clicks(), 1);
});

test('composition, modified Enter and other keys do not trigger sending', () => {
  const input = keyboard();
  for (const event of [{ isComposing: true }, { keyCode: 229 }, { shiftKey: true }, { ctrlKey: true },
    { altKey: true }, { metaKey: true }, { key: 'a' }]) {
    assert.equal(input.press(event), false);
  }
  assert.equal(input.clicks(), 0);
});
