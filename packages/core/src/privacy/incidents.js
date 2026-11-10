import { atomic } from '../database/atomic.js';
import { log } from '../audit/log.js';

/**
 * Register of security incidents. One row per incident: what happened, when it was found, whether personal data
 * is involved, and the dates the regulator was told. For incidents with personal data the register computes two
 * deadlines from the moment of detection (default 24 h for the first notice, 72 h for the details; the numbers are
 * options because the law changes - check them with a lawyer). The register only records and reminds; it does not send anything.
 */
export const INCIDENT_SEVERITIES = ['low', 'medium', 'high'];
export const INCIDENT_STATUSES = ['open', 'notified', 'closed'];
const HOUR = 3600 * 1000;
const MAX = { title: 200, description: 4000, measures: 4000 };

export class IncidentError extends Error {
  constructor(code, message) { super(message ?? code); this.name = 'IncidentError'; this.code = code; }
}

const str = (v, max, code, { required = false } = {}) => {
  const s = String(v ?? '').trim();
  if (required && !s) throw new IncidentError(code);
  if (s.length > max) throw new IncidentError(code);
  return s;
};
const isoOrNull = (v, code) => {
  if (v == null || v === '') return null;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) throw new IncidentError(code);
  return new Date(t).toISOString();
};

/**
 * @param {object} db
 * @param {object} [o]
 * @param {number} [o.firstNoticeHours=24]
 * @param {number} [o.detailsHours=72]
 * @param {() => number} [o.now]
 */
export function createIncidentRegister(db, { firstNoticeHours = 24, detailsHours = 72, now = () => Date.now() } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS security_incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    severity TEXT NOT NULL DEFAULT 'medium',
    personal_data INTEGER NOT NULL DEFAULT 0,
    detected_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    first_notice_at TEXT,
    details_notice_at TEXT,
    measures TEXT NOT NULL DEFAULT '',
    closed_at TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL
  )`);

  const view = (r) => {
    if (!r) return null;
    const detected = Date.parse(r.detected_at);
    const personal = r.personal_data === 1;
    const t = now();
    const due = (hours, doneAt) => {
      if (!personal) return null;
      const at = new Date(detected + hours * HOUR).toISOString();
      return { at, done: doneAt != null, overdue: doneAt == null && r.status !== 'closed' && t > detected + hours * HOUR };
    };
    return {
      id: r.id, title: r.title, description: r.description, severity: r.severity, personalData: personal,
      detectedAt: r.detected_at, status: r.status, firstNoticeAt: r.first_notice_at, detailsNoticeAt: r.details_notice_at,
      measures: r.measures, closedAt: r.closed_at, createdBy: r.created_by, createdAt: r.created_at,
      firstNoticeDue: due(firstNoticeHours, r.first_notice_at), detailsDue: due(detailsHours, r.details_notice_at),
    };
  };

  const audit = (actor, action, id, meta = {}) => log(db, { actor, action, entity: 'security_incident', entityId: String(id), meta });

  function get(id) { return view(db.get('SELECT * FROM security_incidents WHERE id = ?', [Number(id)])); }

  function list({ status, limit = 1000, offset = 0 } = {}) {
    const lim = Math.min(1000, Math.max(1, Math.trunc(Number(limit)) || 1000));
    const off = Math.max(0, Math.trunc(Number(offset)) || 0);
    const rows = status ? db.all('SELECT * FROM security_incidents WHERE status = ? ORDER BY id DESC LIMIT ? OFFSET ?', [status, lim, off]) : db.all('SELECT * FROM security_incidents ORDER BY id DESC LIMIT ? OFFSET ?', [lim, off]);
    return rows.map(view);
  }

  function count({ status } = {}) {
    return (status ? db.get('SELECT COUNT(*) AS n FROM security_incidents WHERE status = ?', [status]) : db.get('SELECT COUNT(*) AS n FROM security_incidents')).n;
  }

  /** Open incidents with personal data whose notice deadline has passed. */
  const overdue = () => list().filter((i) => i.firstNoticeDue?.overdue || i.detailsDue?.overdue);

  function declare({ title, description = '', severity = 'medium', personalData = false, detectedAt, actor = null } = {}) {
    const t = str(title, MAX.title, 'TITLE_INVALID', { required: true });
    const d = str(description, MAX.description, 'DESCRIPTION_INVALID');
    if (!INCIDENT_SEVERITIES.includes(severity)) throw new IncidentError('SEVERITY_INVALID');
    const det = isoOrNull(detectedAt, 'DATE_INVALID') ?? new Date(now()).toISOString();
    const r = db.run('INSERT INTO security_incidents (title, description, severity, personal_data, detected_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [t, d, severity, personalData ? 1 : 0, det, actor, new Date(now()).toISOString()]);
    const id = Number(r.lastInsertRowid);
    audit(actor, 'privacy.incident.declare', id, { severity, personalData: Boolean(personalData) });
    return get(id);
  }

  /** Records progress: notice dates, measures taken, status. Only the listed fields are accepted. */
  function update(id, fields = {}) {
    // the row is read, changed in memory and written back whole: one transaction, so a second update cannot slip in between and be undone (G-04)
    return atomic(db, () => updateNow(id, fields));
  }

  function updateNow(id, { firstNoticeAt, detailsNoticeAt, measures, status, severity, actor = null } = {}) {
    const cur = db.get('SELECT * FROM security_incidents WHERE id = ?', [Number(id)]);
    if (!cur) throw new IncidentError('NOT_FOUND');
    const next = { first: cur.first_notice_at, details: cur.details_notice_at, measures: cur.measures, severity: cur.severity, status: cur.status, closed: cur.closed_at };
    const meta = {};
    if (firstNoticeAt !== undefined) { next.first = isoOrNull(firstNoticeAt, 'DATE_INVALID'); meta.firstNoticeAt = true; }
    if (detailsNoticeAt !== undefined) { next.details = isoOrNull(detailsNoticeAt, 'DATE_INVALID'); meta.detailsNoticeAt = true; }
    if (measures !== undefined) { next.measures = str(measures, MAX.measures, 'MEASURES_INVALID'); meta.measures = true; }
    if (severity !== undefined) {
      if (!INCIDENT_SEVERITIES.includes(severity)) throw new IncidentError('SEVERITY_INVALID');
      next.severity = severity; meta.severity = true;
    }
    if (status !== undefined) {
      if (!INCIDENT_STATUSES.includes(status)) throw new IncidentError('STATUS_INVALID');
      next.status = status; meta.statusTo = status;
      next.closed = status === 'closed' ? new Date(now()).toISOString() : null;
    }
    if (!Object.keys(meta).length) return view(cur);
    db.run('UPDATE security_incidents SET first_notice_at = ?, details_notice_at = ?, measures = ?, severity = ?, status = ?, closed_at = ? WHERE id = ?',
      [next.first, next.details, next.measures, next.severity, next.status, next.closed, Number(id)]);
    audit(actor, 'privacy.incident.update', id, { ...meta, ...(status !== undefined ? { statusTo: status } : {}) });
    return get(id);
  }

  return { declare, update, get, list, count, overdue, firstNoticeHours, detailsHours };
}
