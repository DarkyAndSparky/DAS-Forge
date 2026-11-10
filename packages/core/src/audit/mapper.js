import { createResolver } from './subjects.js';

/**
 * Shared row -> AuditEntry shape, used by both log.js (returns the row
 * it just inserted) and query.js (returns matched rows) so the two
 * never drift apart on field naming.
 *
 * actor/ip/meta hold pseudonyms (audit F03); pass `resolver` (createResolver(db)) to get the real
 * values back - an erased subject reads "[erased]". Without a resolver the raw stored form is
 * returned (what leaves the machine through onEntry / the log mirror).
 */
export function rowToEntry(row, resolver = null) {
  if (!row) return null;
  const meta = parseMeta(row.meta);
  return {
    id: row.id,
    actor: resolver && row.actor != null ? resolver.value(row.actor) : row.actor,
    action: row.action,
    entity: row.entity,
    entityId: row.entity_id,
    result: row.result,
    meta: resolver ? resolver.meta(meta) : meta,
    requestId: row.request_id,
    ip: resolver && row.ip != null ? resolver.value(row.ip) : row.ip,
    createdAt: row.created_at,
  };
}

export function rowsToEntries(db, rows) {
  const resolver = createResolver(db);
  return rows.map((r) => rowToEntry(r, resolver));
}

/** A corrupt meta column must not make the whole query() throw. */
function parseMeta(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { _unparseable: true };
  }
}
