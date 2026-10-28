const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const [modulePath, nativeDirectory] = process.argv.slice(2);
const { Entry } = require(modulePath);
const canonical = value => path.toNamespacedPath(fs.realpathSync.native(value)).toLowerCase();
const prefix = canonical(nativeDirectory) + path.sep;
assert(process.report.getReport().sharedObjects.some(file =>
  canonical(file).startsWith(prefix) && path.basename(file).toLowerCase() === 'vcruntime140.dll'),
'Credential module must load the bundled VC runtime');
// Exercise the actual credential API under a unique throwaway test identity.
const entry = new Entry('SapLink.Installer.BuildTest', crypto.randomUUID());
const secret = crypto.randomBytes(32).toString('hex');
try {
  entry.setPassword(secret);
  assert.equal(entry.getPassword(), secret);
} finally {
  entry.deleteCredential();
}
console.log(`Verified native credentials and bundled VC runtime: ${process.arch}`);
