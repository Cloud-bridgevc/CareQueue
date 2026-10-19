// Append-only, hash-chained audit log. Each entry commits to the previous
// entry's hash, so any edit or deletion breaks verification. In production
// this maps to the audit_log table (INSERT-only grants) plus an S3 Object
// Lock export; see db/schema.sql.

import { createHash, randomUUID } from 'node:crypto';

export class AuditLog {
  constructor() {
    this.entries = [];
  }

  append({ actor, action, entity, entityId = null, detail = {}, outcome = 'success' }) {
    const prev = this.entries.at(-1)?.hash || 'GENESIS';
    const entry = {
      id: randomUUID(),
      at: new Date().toISOString(),
      actorId: actor?.id || 'system',
      actorRole: actor?.role || 'system',
      action, entity, entityId, outcome,
      detail,
      prevHash: prev,
    };
    entry.hash = hash(entry);
    this.entries.push(entry);
    return entry;
  }

  verify() {
    let prev = 'GENESIS';
    for (const [i, e] of this.entries.entries()) {
      if (e.prevHash !== prev || hash(e) !== e.hash) return { ok: false, brokenAt: i, entryId: e.id };
      prev = e.hash;
    }
    return { ok: true, entries: this.entries.length, head: prev };
  }

  query({ actorId, entity, action, limit = 200 } = {}) {
    return this.entries
      .filter((e) => (!actorId || e.actorId === actorId) && (!entity || e.entity === entity) && (!action || e.action.startsWith(action)))
      .slice(-limit)
      .reverse();
  }
}

function hash(e) {
  const { hash: _ignored, ...body } = e;
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}
