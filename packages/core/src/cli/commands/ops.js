import { flagString, flagInt } from '../arg-parser.js';
import { EXIT } from '../exit-codes.js';
import { cliActor } from '../actor.js';
import { createMaintenance, MaintenanceError } from '../../maintenance/index.js';
import { findUserByUsername } from '../../auth/users.js';
import { destroyUserSessions } from '../../auth/sessions.js';
import { log } from '../../audit/log.js';
import { ensureAuthTables } from '../../auth/schema.js';
import { createAnnouncement, AnnouncementError } from '../../announcement/index.js';
import { createEmailQueue } from '../../email/queue.js';
import { purgeOlderThan, archiveAndPurge } from '../../audit/retention.js';

const say = (s) => console.log(s); // eslint-disable-line no-console
const fail = (s, code = EXIT.USAGE) => { console.error(s); return code; }; // eslint-disable-line no-console
const audit = (db, entry) => { try { log(db, { actor: cliActor(), ...entry }); } catch { /* the audit table may not exist yet */ } };

/**
 * Operations commands the administration has (audit R-09), for scripts and deploys:
 *   `maintenance status|on|off`  - the mode is kept in the database, a running server picks it up within a couple of seconds
 *   `sessions list|revoke`       - who is signed in, and signing a user out everywhere
 *   `announcement show|set|clear`, `mail queue|purge`, `audit purge` - the same as the administration pages
 * @param {object} opts
 * @param {object} opts.db
 */
export function registerOpsCommands(cli, { db }) {
  const maintenance = createMaintenance({ db, cacheMs: 0 });

  cli.command('maintenance status', {
    description: 'Show whether maintenance mode is on (app maintenance status [--json])',
    handler({ flags }) {
      const s = maintenance.get({ fresh: true });
      if (flags.json) { say(JSON.stringify(s)); return 0; }
      say(s.enabled ? `ON since ${s.startedAt}${s.startedBy ? ` by ${s.startedBy}` : ''}${s.until ? `, expected end ${s.until}` : ''}${s.message ? ` - "${s.message}"` : ''}` : 'off');
      return 0;
    },
  });

  cli.command('maintenance on', {
    description: 'Turn maintenance mode on (app maintenance on [--message text] [--until 2026-12-01T10:00:00Z])',
    handler({ flags }) {
      try {
        const s = maintenance.enable({ message: flagString(flags, 'message') ?? null, until: flagString(flags, 'until') ?? null, by: cliActor() });
        audit(db, { action: 'admin.maintenance.enable', entity: 'maintenance', meta: { message: s.message, until: s.until } });
        say(`Maintenance mode ON${s.until ? ` (expected end ${s.until})` : ''}. Turn it off with: maintenance off`);
        return 0;
      } catch (err) {
        if (err instanceof MaintenanceError) return fail(err.message);
        throw err;
      }
    },
  });

  cli.command('maintenance off', {
    description: 'Turn maintenance mode off (app maintenance off)',
    handler() {
      const was = maintenance.get({ fresh: true }).enabled;
      maintenance.disable();
      audit(db, { action: 'admin.maintenance.disable', entity: 'maintenance', meta: {} });
      say(was ? 'Maintenance mode OFF.' : 'Maintenance mode was already off.');
      return 0;
    },
  });

  cli.command('sessions list', {
    description: 'Who is signed in: one line per user (app sessions list [--json]). Session ids are never printed',
    handler({ flags }) {
      ensureAuthTables(db);
      const rows = db.all(`SELECT u.username, COUNT(*) AS sessions, MAX(COALESCE(s.last_seen_at, s.created_at)) AS last_seen
        FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.expires_at > ? GROUP BY u.id ORDER BY last_seen DESC`, [new Date().toISOString()]);
      if (flags.json) { say(JSON.stringify(rows)); return 0; }
      if (rows.length === 0) { say('No active sessions.'); return 0; }
      for (const r of rows) say(`${r.username.padEnd(24)} ${String(r.sessions).padStart(3)} session(s)  last seen ${r.last_seen}`);
      return 0;
    },
  });

  cli.command('sessions revoke', {
    description: 'Sign a user out everywhere (app sessions revoke <username>)',
    handler({ positionals }) {
      const username = positionals[0];
      if (!username) return fail('Usage: sessions revoke <username>');
      const user = findUserByUsername(db, username);
      if (!user) return fail(`No such user: "${username}"`, EXIT.FAILURE);
      const n = destroyUserSessions(db, user.id);
      audit(db, { action: 'admin.user.force_logout', entity: 'user', entityId: user.id, meta: { revokedSessions: n, via: 'cli' } });
      say(`Revoked ${n} session(s) of "${username}".`);
      return 0;
    },
  });

  const announcement = createAnnouncement({ db, cacheMs: 0 });

  cli.command('announcement show', {
    description: 'Show the banner shown at the top of pages (app announcement show [--json])',
    handler({ flags }) {
      const s = announcement.get({ fresh: true });
      if (flags.json) { say(JSON.stringify(s)); return 0; }
      say(s.enabled ? `[${s.level}] ${s.message}${s.until ? ` (until ${s.until})` : ''}` : 'none');
      return 0;
    },
  });

  cli.command('announcement set', {
    description: 'Publish the banner (app announcement set "text" [--level info|warning|critical] [--until 2030-01-01T10:00:00Z])',
    handler({ positionals, flags }) {
      try {
        const s = announcement.set({ message: positionals.join(' '), level: flagString(flags, 'level') ?? 'info', until: flagString(flags, 'until') ?? null, by: cliActor() });
        audit(db, { action: 'admin.announcement.set', entity: 'announcement', meta: { message: s.message, level: s.level, until: s.until, via: 'cli' } });
        say('Announcement published.');
        return 0;
      } catch (err) {
        if (err instanceof AnnouncementError) return fail(err.message);
        throw err;
      }
    },
  });

  cli.command('announcement clear', {
    description: 'Remove the banner (app announcement clear)',
    handler() {
      announcement.clear();
      audit(db, { action: 'admin.announcement.clear', entity: 'announcement', meta: { via: 'cli' } });
      say('Announcement removed.');
      return 0;
    },
  });

  // Only reads and cleans the table: sending is the running server's job, so the queue gets a sender that refuses.
  const mailQueue = () => createEmailQueue({ db, send: async () => { throw new Error('the CLI does not send mail'); } });

  cli.command('mail queue', {
    description: 'Mail queue: counters and the newest rows, without bodies (app mail queue [--status pending|sending|sent|failed] [--limit n] [--json])',
    handler({ flags }) {
      const q = mailQueue();
      const status = flagString(flags, 'status') ?? null;
      if (status && !['pending', 'sending', 'sent', 'failed'].includes(status)) return fail('--status must be pending, sending, sent or failed');
      const stats = q.stats();
      const rows = q.list({ limit: flagInt(flags, 'limit', { min: 1, max: 200 }) ?? 20, status });
      if (flags.json) { say(JSON.stringify({ stats, rows })); return 0; }
      say(`pending ${stats.pending}, sending ${stats.sending}, sent ${stats.sent}, failed ${stats.failed}`);
      for (const r of rows) say(`#${r.id} ${r.status.padEnd(7)} ${r.scenario.padEnd(18)} attempts ${r.attempts}  ${r.createdAt}${r.lastError ? `  ${r.lastError}` : ''}`);
      return 0;
    },
  });

  cli.command('mail purge', {
    description: 'Delete finished (sent/failed) queue rows older than N days (app mail purge [--days 7])',
    handler({ flags }) {
      const n = mailQueue().purgeFinished({ olderThanDays: flagInt(flags, 'days', { min: 0, max: 3650 }) ?? 7 });
      audit(db, { action: 'admin.mail.purge', entity: 'email_queue', meta: { removed: n, via: 'cli' } });
      say(`Removed ${n} row(s).`);
      return 0;
    },
  });

  cli.command('audit purge', {
    description: 'Delete audit entries older than a date; the chain stays valid (app audit purge --before 2026-01-01 --yes [--archive-dir dir])',
    async handler({ flags }) {
      const before = flagString(flags, 'before');
      const ms = before ? Date.parse(before) : NaN;
      if (Number.isNaN(ms)) return fail('Usage: audit purge --before <date> --yes [--archive-dir <dir>]');
      if (!flags.yes) return fail('This deletes audit entries for good. Repeat with --yes to confirm (--archive-dir keeps a copy first).');
      const cutoff = new Date(ms).toISOString();
      const dir = flagString(flags, 'archive-dir');
      try {
        if (dir) {
          const r = await archiveAndPurge(db, cutoff, { archiveDir: dir, actor: cliActor() });
          say(`Removed ${r.removed} entr${r.removed === 1 ? 'y' : 'ies'}${r.archive ? `, archived to ${r.archive.file}` : ''}.`);
        } else {
          const n = purgeOlderThan(db, cutoff, { record: true, actor: cliActor() });
          say(`Removed ${n} entr${n === 1 ? 'y' : 'ies'} (no archive).`);
        }
        return 0;
      } catch (err) {
        return fail(`Not done: ${err.message}`, EXIT.FAILURE);
      }
    },
  });
}
