import { writeCsv } from '../../csv/index.js';
import { flagInt, flagString } from '../arg-parser.js';
import { writeOwnerOnly } from '../safe-write.js';
import { EXIT } from '../exit-codes.js';

/**
 * `app audit tail [--limit n] [--json]` and `app audit export <file>
 * [--format json|csv]` - thin CLI wrapper over core/audit's tail()/
 * query(), same pattern as every other command group here (core does
 * the work, this file does argv parsing and console/file output).
 *
 * @param {object} cli
 * @param {object} opts
 * @param {import('../../database/adapter.js')} opts.db
 * @param {(db, opts:object) => Array} opts.tailFn - core/audit's tail()
 * @param {(db, opts:object) => Array} opts.queryFn - core/audit's query()
 */
export function registerAuditCommands(cli, { db, tailFn, queryFn, verifyFn, anchorFn }) {
  cli.command('audit tail', {
    description: 'Show the most recent audit log entries (app audit tail [--limit n])',
    handler({ flags }) {
      const limit = flagInt(flags, 'limit', { min: 1, max: 1000 }) ?? 50;
      const entries = tailFn(db, { limit });

      if (flags.json) {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(entries));
        return 0;
      }

      if (entries.length === 0) {
        // eslint-disable-next-line no-console
        console.log('No audit entries.');
        return 0;
      }

      for (const e of entries) {
        const entityPart = e.entity ? ` ${e.entity}${e.entityId != null ? `#${e.entityId}` : ''}` : '';
        // eslint-disable-next-line no-console
        console.log(`  ${e.createdAt}  ${e.result === 'success' ? ' ok ' : 'FAIL'}  ${e.actor ?? '-'}  ${e.action}${entityPart}`);
      }
      return 0;
    },
  });

  cli.command('audit export', {
    description: 'Export audit log entries to a file (app audit export <file> [--format json|csv] [--limit n])',
    handler({ positionals, flags }) {
      const file = positionals[0];
      if (!file) {
        // eslint-disable-next-line no-console
        console.error('Usage: audit export <file> [--format json|csv] [--limit n] [--since <iso>] [--until <iso>] [--force]');
        return EXIT.USAGE;
      }

      const format = flags.format === 'csv' ? 'csv' : 'json';
      // The query layer caps one call at 1000 rows: walk the log page by page (newest first)
      // so a big export is complete, not silently cut (audit G03). `--limit` caps the total.
      const wanted = flagInt(flags, 'limit', { min: 1 }) ?? Infinity;
      const since = flagString(flags, 'since');
      const until = flagString(flags, 'until');
      const entries = [];
      let beforeId;
      while (entries.length < wanted) {
        const size = Math.min(1000, wanted - entries.length);
        const batch = queryFn(db, { limit: size, since, until, beforeId });
        entries.push(...batch);
        if (batch.length < size) break;
        beforeId = batch[batch.length - 1].id;
      }

      if (format === 'json') {
        writeOwnerOnly(file, JSON.stringify(entries, null, 2), { force: flags.force === true });
      } else {
        const rows = [['id', 'createdAt', 'actor', 'action', 'entity', 'entityId', 'result', 'requestId', 'ip', 'meta'], ...entries.map((e) => [e.id, e.createdAt, e.actor, e.action, e.entity, e.entityId, e.result, e.requestId, e.ip, JSON.stringify(e.meta)])];
        writeOwnerOnly(file, writeCsv(rows, { eol: '\n' }), { force: flags.force === true });
      }

      // eslint-disable-next-line no-console
      console.log(`Exported ${entries.length} entries to ${file} (${format}).`);
      return 0;
    },
  });

  if (verifyFn) {
    cli.command('audit verify', {
      description: 'Check the audit hash chain (app audit verify [--anchor-id <n> --anchor-hash <hash>])',
      handler({ flags }) {
        const id = flagInt(flags, 'anchor-id', { min: 1 });
        const hash = flagString(flags, 'anchor-hash');
        if ((id === undefined) !== (hash === undefined)) {
          // eslint-disable-next-line no-console
          console.error('Pass --anchor-id and --anchor-hash together (copy them from the remote log line "audit anchor").');
          return EXIT.USAGE;
        }
        const result = verifyFn(db, id === undefined ? {} : { anchor: { id, hash } });
        if (flags.json) {
          // eslint-disable-next-line no-console
          console.log(JSON.stringify(result));
        } else if (result.ok) {
          // eslint-disable-next-line no-console
          console.log(`✓ audit chain intact (${result.checked} entries checked${id === undefined ? '' : `, anchor #${id} matches`})`);
        } else {
          // eslint-disable-next-line no-console
          console.error(`✗ audit chain BROKEN at entry ${result.brokenAtId}: ${result.reason}`);
        }
        return result.ok ? EXIT.OK : EXIT.CHECK_FAILED;
      },
    });
  }

  if (anchorFn) {
    cli.command('audit anchor', {
      description: 'Print the current audit chain head (id, hash): keep it somewhere the server cannot reach (app audit anchor)',
      handler({ flags }) {
        const a = anchorFn(db);
        if (!a) {
          // eslint-disable-next-line no-console
          console.log('No hashed audit entries yet.');
          return EXIT.OK;
        }
        // eslint-disable-next-line no-console
        console.log(flags.json ? JSON.stringify(a) : `anchor-id=${a.id} anchor-hash=${a.hash} entries=${a.count} at=${a.at}`);
        return EXIT.OK;
      },
    });
  }
}
