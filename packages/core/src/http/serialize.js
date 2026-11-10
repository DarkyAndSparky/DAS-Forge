/**
 * §4.5j zero-trust client<->server: fields the viewer shouldn't see are
 * cut BEFORE the response is sent, server-side - never hidden only in
 * the UI (devtools / a raw fetch() call bypasses UI-only hiding
 * trivially). This is the one place that decision gets enforced.
 *
 * A "field permission map" is a plain object: { fieldName: requiredPermission }.
 * In the default mode a field with no entry in the map is always included - only fields
 * that actually need gating should be listed, to keep the map short
 * and the default safe-by-inclusion rather than accidentally
 * safe-by-omission (an unlisted sensitive field would leak silently,
 * so field permission maps should be reviewed as part of adding any
 * new sensitive column, not relied on as a catch-all).
 *
 * For new entities prefer `strict: true` (audit A19): the map becomes an
 * ALLOWLIST - a field that is not listed is dropped, so a column added to the
 * table later stays private until someone decides to expose it. Map values:
 *   'perm:name'  visible only to viewers that have that permission
 *   true         visible to everyone (what the default mode does for unlisted fields)
 */

/**
 * @param {object|object[]} entity - a row/object, or array of them
 * @param {object} opts
 * @param {Set<string>|string[]} opts.viewerPermissions - permissions the
 *   current viewer actually has (from req.session/req.user - NEVER from
 *   request body/query, per zero-trust)
 * @param {Record<string,string|true>} opts.fieldPermissions - map of
 *   fieldName -> required permission (or `true` = public)
 * @param {boolean} [opts.strict=false] - allowlist mode: unlisted fields are dropped
 */
export function serialize(entity, { viewerPermissions, fieldPermissions = {}, strict = false }) {
  const perms = viewerPermissions instanceof Set ? viewerPermissions : new Set(viewerPermissions);

  const visible = (key) => {
    // Own keys only: a column called "constructor" or "toString" must not pick up
    // Object.prototype members as if they were permission entries.
    if (!Object.hasOwn(fieldPermissions, key)) return !strict;
    const required = fieldPermissions[key];
    if (required === true) return true;
    if (!required) return !strict; // undefined/''/false: same as unlisted
    return perms.has(required);
  };

  const serializeOne = (obj) => {
    if (obj === null || typeof obj !== 'object') return obj;
    // fromEntries defines own properties, so a key named "__proto__" stays data.
    return Object.fromEntries(Object.entries(obj).filter(([key]) => visible(key)));
  };

  return Array.isArray(entity) ? entity.map(serializeOne) : serializeOne(entity);
}

/**
 * For tests and startup checks: the field names in `entityOrRows` that the
 * map does not mention. In strict mode these are exactly the fields that
 * would be dropped; in the default mode they are the ones that would leak
 * to everybody - assert it is empty (or equals a reviewed list) for every
 * entity an app exposes, so a new column cannot become public unnoticed.
 *
 * @returns {string[]} sorted unique field names
 */
export function findUnmappedFields(entityOrRows, fieldPermissions = {}) {
  const rows = Array.isArray(entityOrRows) ? entityOrRows : [entityOrRows];
  const missing = new Set();
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    for (const key of Object.keys(row)) {
      if (!Object.hasOwn(fieldPermissions, key) || !fieldPermissions[key]) missing.add(key);
    }
  }
  return [...missing].sort();
}
