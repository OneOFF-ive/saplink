import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('GUI child exit stops polling and guards reentrancy before any modal warning', async () => {
  const source = await readFile(new URL('../packaging/windows/GuiLauncher.cs', import.meta.url), 'utf8');
  const tick = source.slice(source.indexOf('timer.Tick += delegate'), source.indexOf('timer.Start();'));
  const guard = tick.indexOf('if (exitHandled) return;');
  const handled = tick.indexOf('exitHandled = true;');
  const stopped = tick.indexOf('timer.Stop();');
  const dialog = tick.indexOf('MessageBox.Show(');
  assert.ok(guard >= 0 && guard < tick.indexOf('child.HasExited'));
  assert.ok(handled > guard && handled < stopped && stopped < dialog);
  assert.ok(tick.indexOf('child.ExitCode') < tick.indexOf('child.Dispose();'));
  assert.ok(tick.indexOf('tray.Dispose();') < dialog);
  assert.ok(tick.indexOf('child.Dispose();') < dialog);
  assert.match(tick, /finally\s*\{\s*ExitThread\(\);\s*\}/);
});
