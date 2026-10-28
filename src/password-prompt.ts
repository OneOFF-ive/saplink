import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AppError } from './errors.js';
import type { Connection } from './config.js';

const execute = promisify(execFile);

// The password travels only through a private child-process pipe into keyring memory.
// It is never placed in command arguments, environment variables or CLI output.
export async function promptLocalPassword(connection: Pick<Connection, 'name' | 'base_url' | 'username' | 'client' | 'rfc'>): Promise<string> {
  if (process.platform !== 'win32') throw new AppError('INTERACTION_REQUIRED', 'Local password dialog requires Windows.');
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$form = New-Object System.Windows.Forms.Form
$form.Text = 'SapLink - 输入 SAP 密码'
$form.Width = 440; $form.Height = 230
$form.StartPosition = 'CenterScreen'; $form.TopMost = $true
$label = New-Object System.Windows.Forms.Label
$label.Text = $env:SAPLINK_PROMPT_NAME + [Environment]::NewLine + $env:SAPLINK_PROMPT_SERVER + [Environment]::NewLine + 'Client: ' + $env:SAPLINK_PROMPT_CLIENT + '  User: ' + $env:SAPLINK_PROMPT_USER
$label.SetBounds(15, 15, 395, 65)
$field = New-Object System.Windows.Forms.TextBox
$field.UseSystemPasswordChar = $true; $field.MaxLength = 512
$field.SetBounds(15, 90, 395, 25)
$ok = New-Object System.Windows.Forms.Button
$ok.Text = '保存'; $ok.SetBounds(220, 135, 90, 28)
$ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
$cancel = New-Object System.Windows.Forms.Button
$cancel.Text = '取消'; $cancel.SetBounds(320, 135, 90, 28)
$cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$form.Controls.AddRange(@($label, $field, $ok, $cancel))
$form.AcceptButton = $ok; $form.CancelButton = $cancel
try {
  if ($form.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { exit 2 }
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  [Console]::Out.Write($field.Text)
} finally { $field.Clear(); $form.Dispose() }
`;
  try {
    const result = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script],
      { windowsHide: true, cwd: process.env.SystemRoot ?? 'C:\\Windows', timeout: 300000, maxBuffer: 8192, encoding: 'utf8',
        env: { ...process.env, SAPLINK_PROMPT_NAME: connection.name,
          SAPLINK_PROMPT_SERVER: connection.rfc ? `RFC ${connection.rfc.ashost} / ${connection.rfc.sysnr}` : connection.base_url,
          SAPLINK_PROMPT_CLIENT: connection.client, SAPLINK_PROMPT_USER: connection.username } });
    if (!result.stdout) throw new AppError('PASSWORD_REQUIRED', 'Password cannot be empty.');
    return result.stdout;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('PASSWORD_INPUT_CANCELLED', 'Local password input was cancelled, unavailable, or timed out. No password was saved.');
  }
}
