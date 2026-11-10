import { createHash } from 'node:crypto';
import type { Connection } from './config.js';

// Excludes display names and the write switch; binds the actual SAP login target.
export function targetFingerprint(connection: Connection) {
  return createHash('sha256').update(JSON.stringify([connection.connection_id, connection.base_url,
    connection.rfc ?? null, connection.client, connection.username, connection.language])).digest('hex');
}
