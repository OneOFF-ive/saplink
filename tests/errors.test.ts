import test from 'node:test';
import assert from 'node:assert/strict';
import { AdtErrorException } from 'abap-adt-api';
import { safeError, attachBackendDiagnostic } from '../src/errors.js';

test('SAP XML exceptions expose status stored in err and redact lock handles', () => {
  const error = AdtErrorException.create(400, { 'T100KEY-ID': 'FUNC_ADT', 'T100KEY-NO': '012' },
    'ResourceNotLocked', 'Resource function module ZFM_MCP_TEST is not locked (invalid lock handle: ABC123SECRET)');
  const result = safeError(error);
  assert.equal(result.details?.http_status, 400);
  assert.ok(result.details?.sap_message?.includes('Resource function module ZFM_MCP_TEST'));
  assert.equal(result.details?.sap_message_id, 'FUNC_ADT');
  assert.equal(JSON.stringify(result).includes('ABC123SECRET'), false);
});
test('SAP XML status affects classification and localized message is preferred', () => {
  const error = AdtErrorException.create(403, {}, 'EditorLock', 'original', undefined, undefined, '当前编辑，资源已锁定');
  const result = safeError(error);
  assert.equal(result.code, 'OBJECT_LOCKED'); assert.equal(result.details?.sap_message, '当前编辑，资源已锁定');
  assert.equal(safeError(AdtErrorException.create(404, {}, '', 'Object absent')).code, 'OBJECT_NOT_FOUND');
});
test('SAP messages redact credentials and are bounded; raw request and response are excluded', () => {
  const error = AdtErrorException.create(400, {}, 'FormatError',
    'password=SECRET1 Authorization: Bearer SECRET2 Cookie: SAP_SESSIONID=SECRET3 x-csrf-token: SECRET4 http://user:SECRET5@host ' + 'x'.repeat(3000));
  const result = safeError(error); const serialized = JSON.stringify(result);
  for (const secret of ['SECRET1', 'SECRET2', 'SECRET3', 'SECRET4', 'SECRET5']) assert.equal(serialized.includes(secret), false);
  assert.ok((result.details?.sap_message?.length ?? 0) <= 1024);
  const unknown = safeError({ status: 500, message: 'raw SECRET6', request: { auth: { password: 'SECRET6' } }, response: { status: 500, body: 'SECRET6' } });
  assert.equal(JSON.stringify(unknown).includes('SECRET6'), false);
  assert.equal(unknown.details?.http_status, 500);
});
test('authentication failures never expose SAP message text', () => {
  const result = safeError(AdtErrorException.create(401, {}, '', 'password SECRET'));
  assert.equal(result.code, 'AUTH_FAILED'); assert.equal(result.details?.http_status, 401);
  assert.equal(result.details?.sap_message, undefined);
});


test('transport diagnostics survive exception wrapping and later cleanup requests', () => {
  const original = new Error('PRIVATE_TRANSPORT');
  const diagnostic = { request_path: '/sap/bc/adt/programs/programs/ztest/source/main', request_method: 'PUT',
    network_code: 'ETIMEDOUT', elapsed_ms: 15000, error_kind: 'http_transport' };
  attachBackendDiagnostic(original, diagnostic);
  diagnostic.request_method = 'DELETE';
  const result = safeError({ parent: original });
  assert.equal(result.code, 'OUTCOME_UNKNOWN');
  assert.equal(result.details?.request_method, 'PUT');
  assert.equal(result.details?.elapsed_ms, 15000);
  assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
});
