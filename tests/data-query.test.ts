import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { tableQuery, readOnlySql, queryCapabilities } from '../src/data-query.js';
import { AdtBackend, type AdtBackendOptions } from '../src/adt.js';
import { connectionSchema } from '../src/config.js';
import { safeError } from '../src/errors.js';

test('table query validates identifiers and limits and escapes filter literals', () => {
  assert.equal(tableQuery({ table_name: 'mara' }).sql, '');
  assert.equal(tableQuery({ table_name: '/acme/material', fields: ['matnr'],
    filters: [{ field: 'matnr', operator: 'eq', value: "a' OR '1'='1" }] }).sql,
  "SELECT MATNR FROM /ACME/MATERIAL WHERE MATNR = 'a'' OR ''1''=''1'");
  for (const table_name of ['MARA; DELETE', 'MARA WHERE 1=1', '../MARA']) assert.throws(() => tableQuery({ table_name }));
  for (const limit of [0, 501, 1.1, NaN]) assert.throws(() => tableQuery({ table_name: 'MARA', limit }));
  assert.throws(() => tableQuery({ table_name: 'MARA', fields: ['* FROM USR02'] }));
});

test('SQL guard accepts SELECT joins, aggregates, nested SELECT and quoted data', () => {
  for (const sql of ["SELECT * FROM mara WHERE matnr = 'DELETE; -- ''text'''",
    'SELECT a~matnr, b~maktx FROM mara AS a INNER JOIN makt AS b ON a~matnr = b~matnr',
    'SELECT mtart, COUNT(*) AS n FROM mara GROUP BY mtart',
    'SELECT * FROM mara WHERE matnr IN ( SELECT matnr FROM makt )',
    "SELECT * FROM mara WHERE mtart = 'CLIENT'", 'SELECT * FROM mara WHERE brgew > 1.5']) {
    assert.equal(readOnlySql({ sql }).sql, sql);
  }
});

test('SQL guard rejects mutations, multiple statements, comments and client bypasses', () => {
  for (const sql of ['DELETE FROM mara', 'SELECT * FROM mara; DELETE FROM mara',
    'SELECT * FROM mara. DELETE FROM mara', 'SELECT * FROM mara INTO TABLE x',
    'SELECT * FROM mara -- comment', 'SELECT /* comment */ * FROM mara',
    'SELECT * FROM mara\n* comment', 'SELECT * FROM mara CLIENT SPECIFIED',
    "SELECT * FROM mara USING CLIENT '000'", 'SELECT * FROM x WITH PRIVILEGED ACCESS',
    'SELECT * FROM mara USING ALL CLIENTS',
    'SELECT * FROM mara USING CLIENTS IN @clients',
    'SELECT * FROM mara WHERE matnr IN ( SELECT matnr FROM mara USING ALL CLIENTS )',
    "SELECT * FROM mara WHERE matnr = 'oops", 'SELECT 1', 'SELECT * FROM mara CONNECTION x',
    'SELECT * FROM mara\nUPDATE mara SET mtart = 1']) assert.throws(() => readOnlySql({ sql }), /single SELECT/);
});

test('discovery reports independent endpoint advertisement without assuming authorization', () => {
  const result = queryCapabilities([{ collection: [{ href: '/sap/bc/adt/datapreview/ddic', templateLinks: [] }] }]);
  assert.equal(result.table_query.advertised, true);
  assert.equal(result.sql_query.advertised, false);
  assert.equal(queryCapabilities([{ collection: [{ href: 'datapreview', templateLinks: [
    { template: '/sap/bc/adt/datapreview/freestyle{?rowNumber}' }
  ] }] }]).sql_query.advertised, true);
});

async function fixture(status: number | ((calls: number, logins: number) => number) = 200, body?: string, loginStatus = 200, options: AdtBackendOptions = {}, logoutStatus = 200) {
  const calls: { url: URL; method?: string; body: string; session?: string; cookie?: string }[] = [];
  const logins: URL[] = [];
  const logouts: URL[] = [];
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const url = new URL(req.url!, 'http://local');
    res.setHeader('Content-Type', 'application/xml');
    if (url.pathname.endsWith('/compatibility/graph')) {
      logins.push(url); res.statusCode = loginStatus; res.setHeader('x-csrf-token', 'test');
      res.setHeader('set-cookie', 'SAP_SESSIONID_MOCK_001=fake' + logins.length + '; Path=/'); res.end('<graph/>');
    }
    else if (url.pathname.endsWith('/icf/logoff')) {
      logouts.push(url); res.statusCode = logoutStatus; res.end('');
    }
    else if (url.pathname.includes('/datapreview/')) {
      calls.push({ url, method: req.method, body: text, session: req.headers['x-sap-adt-sessiontype'] as string, cookie: req.headers.cookie });
      res.statusCode = typeof status === 'function' ? status(calls.length, logins.length) : status;
      res.end(body ?? '<tableData><columns><metadata name="MATNR" type="N"/><dataSet><data>000001</data><data>000002</data></dataSet></columns><columns><metadata name="AMOUNT" type="P"/><dataSet><data>123456789012345678.90</data><data>0.00</data></dataSet></columns></tableData>');
    } else res.end('');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const backend = new AdtBackend(connectionSchema.parse({ connection_id: randomUUID(), name: 'mock',
    base_url: `http://127.0.0.1:${address.port}`, client: '001', language: 'EN', username: 'TEST' }), 'fake', options);
  return { backend, calls, logins, logouts, close: async () => { try { await backend.close(); } finally { await new Promise<void>(resolve => server.close(() => resolve())); } } };
}

test('DDIC and freestyle use independent stateless endpoints and preserve precision with bounded results', async () => {
  const f = await fixture();
  try {
    const result = await f.backend.queryTable({ table_name: 'mara', limit: 1 });
    assert.equal(result.row_count, 1); assert.equal(result.truncated, true);
    assert.deepEqual(result.rows, [{ MATNR: '000001', AMOUNT: '123456789012345678.90' }]);
    const first = f.calls[0]; assert.equal(first.url.pathname, '/sap/bc/adt/datapreview/ddic');
    assert.equal(first.body, ''); assert.equal(first.method, 'POST');
    assert.equal(first.url.searchParams.get('ddicEntityName'), 'MARA');
    assert.equal(first.url.searchParams.get('rowNumber'), '2');
    assert.equal(f.logins[0].searchParams.get('sap-client'), '001');
    assert.ok(first.cookie?.includes('SAP_SESSIONID_MOCK_001=fake'));
    assert.equal(first.session, 'stateless');
    await f.backend.queryTable({ table_name: 'mara', fields: ['matnr'], filters: [{ field: 'mtart', operator: 'eq', value: 'FERT' }] });
    assert.equal(f.calls[1].body, "SELECT MATNR FROM MARA WHERE MTART = 'FERT'");
    const sql = 'SELECT matnr FROM mara';
    await f.backend.querySql({ sql, limit: 500 });
    assert.equal(f.calls[2].url.pathname, '/sap/bc/adt/datapreview/freestyle');
    assert.equal(f.calls[2].body, sql); assert.equal(f.calls[2].url.searchParams.get('rowNumber'), '501');
    await assert.rejects(f.backend.querySql({ sql: 'DELETE FROM mara' }));
    assert.equal(f.calls.length, 3);
  } finally { await f.close(); }
});

for (const status of [404, 405, 501, 403, 401]) {
  test(`data query maps HTTP ${status} without confusing permissions and support`, async () => {
    const f = await fixture(status, '<error/>');
    try {
      await assert.rejects(f.backend.queryTable({ table_name: 'MARA' }), e => {
        assert.equal(safeError(e).code, [404, 405, 501].includes(status) ? 'DATA_PREVIEW_FAILED' : status === 401 ? 'AUTH_FAILED' : 'HTTP_FORBIDDEN'); return true;
      });
      assert.equal(f.calls.length, status === 404 ? 2 : 1);
    } finally { await f.close(); }
  });
}

test('empty result retains columns and malformed response fails explicitly', async () => {
  const empty = await fixture(200, '<tableData><columns><metadata name="MATNR" type="C"/><dataSet/></columns></tableData>');
  try { const result = await empty.backend.queryTable({ table_name: 'MARA' }); assert.deepEqual(result.rows, []); assert.equal(result.truncated, false); }
  finally { await empty.close(); }
  const malformed = await fixture(200, '<html>login</html>');
  try { await assert.rejects(malformed.backend.querySql({ sql: 'SELECT * FROM mara' }), /tabular query metadata/); }
  finally { await malformed.close(); }
});

test('a stale preview reader is refreshed once while preserving the query and stateless isolation', async () => {
  const f = await fixture((calls, logins) => calls > 1 && logins === 1 ? 404 : 200);
  const input = { table_name: 'MARA', fields: ['MATNR'], filters: [{ field: 'MTART', operator: 'eq' as const, value: 'FERT' }], limit: 1 };
  try {
    await f.backend.queryTable(input);
    const recovered = await f.backend.queryTable(input);
    assert.equal(recovered.session_recovery, 'reader_recreated_after_http_404');
    assert.equal(recovered.row_count, 1);
    assert.equal(f.logins.length, 2);
    assert.equal(f.calls.length, 3);
    assert.equal(f.calls[1].body, f.calls[2].body);
    assert.equal(f.calls[1].url.search, f.calls[2].url.search);
    assert.ok(f.calls[1].cookie?.includes('fake1'));
    assert.ok(f.calls[2].cookie?.includes('fake2'));
    assert.ok(f.calls.every(call => call.session === 'stateless'));
  } finally { await f.close(); }
});

test('SQL preview also recovers once on a fresh reader', async () => {
  const f = await fixture(calls => calls === 1 ? 404 : 200);
  try {
    const result = await f.backend.querySql({ sql: 'SELECT matnr FROM mara', limit: 1 });
    assert.equal(result.session_recovery, 'reader_recreated_after_http_404');
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[0].body, f.calls[1].body);
  } finally { await f.close(); }
});

test('persistent preview failure is bounded and preserves sanitized SAP diagnostic details', async () => {
  const body = '<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework"><type id="PreviewResourceMissing"/><message lang="en">Resource unavailable password=SECRET</message><localizedMessage lang="en">Resource unavailable password=SECRET</localizedMessage></exc:exception>';
  const f = await fixture(404, body);
  try {
    await assert.rejects(f.backend.queryTable({ table_name: 'MARA' }), error => {
      const failure = safeError(error);
      assert.equal(failure.code, 'DATA_PREVIEW_FAILED');
      const details = failure.details as Record<string, unknown>;
      assert.equal(details.http_status, 404);
      assert.equal(details.request_path, '/sap/bc/adt/datapreview/ddic');
      assert.equal(details.request_method, 'POST');
      assert.equal(details.attempts, 2);
      assert.equal(details.reader_recreated, true);
      assert.equal(details.sap_error_type, 'PreviewResourceMissing');
      assert.match(String(details.sap_message), /Resource unavailable/);
      assert.equal(JSON.stringify(failure).includes('SECRET'), false);
      return true;
    });
    assert.equal(f.calls.length, 2);
  } finally { await f.close(); }
});

test('a login 404 is identified as a login path failure rather than unsupported data preview', async () => {
  const f = await fixture(200, undefined, 404);
  try {
    await assert.rejects(f.backend.queryTable({ table_name: 'MARA' }), error => {
      const failure = safeError(error);
      assert.equal(failure.code, 'OBJECT_NOT_FOUND');
      const details = failure.details as Record<string, unknown>;
      assert.equal(details.request_path, '/sap/bc/adt/compatibility/graph');
      assert.equal(details.reader_recreated, false);
      return true;
    });
    assert.equal(f.calls.length, 0);
    assert.equal(f.logins.length, 1);
  } finally { await f.close(); }
});

test('query idle timeout reuses active sessions and refreshes exactly at the threshold for table and SQL', async () => {
  let now = 10000;
  const f = await fixture(200, undefined, 200, { queryIdleTimeoutMs: 1000, now: () => now });
  const input = { table_name: 'MARA', fields: ['MATNR'], limit: 1 };
  try {
    // An unused reader must not be refreshed, regardless of the clock value.
    assert.equal((await f.backend.queryTable(input)).session_recovery, undefined);
    now += 999;
    assert.equal((await f.backend.queryTable(input)).session_recovery, undefined);
    now += 999;
    assert.equal((await f.backend.queryTable(input)).session_recovery, undefined);
    assert.equal(f.logins.length, 1);
    assert.equal(f.logouts.length, 0);
    now += 1000;
    const result = await f.backend.querySql({ sql: 'SELECT matnr FROM mara', limit: 1 });
    assert.equal(result.session_recovery, 'reader_recreated_after_idle_timeout');
    assert.equal(f.logins.length, 2);
    assert.equal(f.logouts.length, 1);
    assert.ok(f.calls[3].cookie?.includes('fake2'));
    assert.ok(f.calls.every(call => call.session === 'stateless'));
    // The replacement remains reusable; idle refresh does not happen on every query.
    assert.equal((await f.backend.queryTable(input)).session_recovery, undefined);
    assert.equal(f.logins.length, 2);
  } finally { await f.close(); }
});

test('idle time starts when the reader request finishes rather than when it starts', async () => {
  let now = 0;
  const f = await fixture(calls => { if (calls === 1) now = 5000; return 200; }, undefined, 200,
    { queryIdleTimeoutMs: 1000, now: () => now });
  try {
    await f.backend.queryTable({ table_name: 'MARA', limit: 1 });
    now = 5999;
    assert.equal((await f.backend.queryTable({ table_name: 'MARA', limit: 1 })).session_recovery, undefined);
    assert.equal(f.logins.length, 1);
  } finally { await f.close(); }
});

test('idle refresh creates a clean reader even if the expired reader cannot log out', async () => {
  let now = 0;
  const f = await fixture(200, undefined, 200, { queryIdleTimeoutMs: 1000, now: () => now }, 500);
  try {
    await f.backend.queryTable({ table_name: 'MARA', limit: 1 });
    now = 1000;
    const result = await f.backend.queryTable({ table_name: 'MARA', limit: 1 });
    assert.equal(result.session_recovery, 'reader_recreated_after_idle_timeout');
    assert.equal(f.logins.length, 2);
    assert.ok(f.calls[1].cookie?.includes('fake2'));
  } finally { await f.close().catch(() => {}); }
});

test('404 recovery remains bounded after an idle refresh', async () => {
  let now = 0;
  const f = await fixture(calls => calls === 2 ? 404 : 200, undefined, 200,
    { queryIdleTimeoutMs: 1000, now: () => now });
  try {
    await f.backend.queryTable({ table_name: 'MARA', limit: 1 });
    now = 1000;
    const result = await f.backend.queryTable({ table_name: 'MARA', limit: 1 });
    assert.equal(result.session_recovery, 'reader_recreated_after_http_404');
    assert.equal(f.calls.length, 3);
    assert.equal(f.logins.length, 3);
  } finally { await f.close(); }
});

test('idle timeout environment setting has a five minute default and rejects invalid values', async () => {
  const original = process.env.SAPLINK_QUERY_IDLE_TIMEOUT_SECONDS;
  const connection = connectionSchema.parse({ connection_id: randomUUID(), name: 'mock',
    base_url: 'http://127.0.0.1:1', client: '001', language: 'EN', username: 'TEST' });
  try {
    for (const value of ['', '0', '-1', '1.5', 'abc', '86401']) {
      process.env.SAPLINK_QUERY_IDLE_TIMEOUT_SECONDS = value;
      assert.throws(() => new AdtBackend(connection, 'fake'), /SAPLINK_QUERY_IDLE_TIMEOUT_SECONDS/);
    }
    for (const value of [0, -1, NaN, Infinity, 1.5, 86400001])
      assert.throws(() => new AdtBackend(connection, 'fake', { queryIdleTimeoutMs: value }), /idle timeout/);
    delete process.env.SAPLINK_QUERY_IDLE_TIMEOUT_SECONDS;
    let now = 0;
    const f = await fixture(200, undefined, 200, { now: () => now });
    try {
      await f.backend.queryTable({ table_name: 'MARA', limit: 1 });
      now = 300000;
      assert.equal((await f.backend.queryTable({ table_name: 'MARA', limit: 1 })).session_recovery,
        'reader_recreated_after_idle_timeout');
    } finally { await f.close(); }
    process.env.SAPLINK_QUERY_IDLE_TIMEOUT_SECONDS = '10';
    now = 0;
    const configured = await fixture(200, undefined, 200, { now: () => now });
    try {
      await configured.backend.queryTable({ table_name: 'MARA', limit: 1 });
      now = 10000;
      assert.equal((await configured.backend.queryTable({ table_name: 'MARA', limit: 1 })).session_recovery,
        'reader_recreated_after_idle_timeout');
    } finally { await configured.close(); }
  } finally {
    if (original === undefined) delete process.env.SAPLINK_QUERY_IDLE_TIMEOUT_SECONDS;
    else process.env.SAPLINK_QUERY_IDLE_TIMEOUT_SECONDS = original;
  }
});
