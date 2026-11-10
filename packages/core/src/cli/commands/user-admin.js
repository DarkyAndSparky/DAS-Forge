import { randomBytes } from 'node:crypto';
import { cliActor } from '../actor.js';

/**
 * `app user create-admin [--username=NAME] [--force]` - manual fallback
 * for first-run bootstrap (which auto-runs when the DB is empty). This
 * command exists for the recovery case: DB already has users, but
 * nobody can log in (lost password, locked account). Without --force
 * it refuses to touch an existing user base, so it can't be run
 * accidentally against a live production DB.
 */
function generateTempPassword(length = 24) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/**
 * @param {object} cli
 * @param {object} opts
 * @param {import('../../database/adapter.js')} opts.db
 * @param {(plain:string) => Promise<string>} opts.hashPassword - core/auth's hashPassword
 * @param {(db, patch) => object} opts.createUser - core/auth's createUser
 * @param {(db, username) => object|null} opts.findUserByUsername
 * @param {(db, userId, hash, opts) => void} opts.updatePasswordHash
 * @param {(db) => number} opts.countUsers
 * @param {(db, userId) => Array} [opts.listAuthenticators] - core/auth's listAuthenticators
 * @param {(db, userId, authenticatorId, opts) => object} [opts.removeAuthenticator] - core/auth's removeAuthenticator
 * @param {(db, userId, opts) => Promise<string[]>} [opts.generateRecoveryCodes] - core/auth's generateRecoveryCodes
 * @param {object} [opts.userAdmin] - core/auth's account-administration functions (the `auth` namespace works);
 *   when given, `user list/create/rename/set-role/set-email/disable/enable/delete` are registered and
 *   `reset-password` also signs the user out everywhere
 * @param {string[]} [opts.roles] - the roles the app knows (default: any non-empty string)
 * @param {string} [opts.adminRole='admin']
 * @param {(entry: object) => any} [opts.auditLog] - records a CLI action in the audit log (actor "cli")
 */
export function registerUserCommands(
  cli,
  {
    db,
    hashPassword,
    createUser,
    findUserByUsername,
    updatePasswordHash,
    countUsers,
    listAuthenticators,
    removeAuthenticator,
    generateRecoveryCodes,
    userAdmin,
    roles,
    adminRole = 'admin',
    auditLog,
  }
) {
  const record = (action, user, meta = {}) => {
    try {
      auditLog?.({ actor: cliActor(), action, entity: 'user', entityId: user?.id ?? null, meta: { username: user?.username, ...meta } });
    } catch {
      /* the audit trail must not turn a finished operation into a failure */
    }
  };

  cli.command('user create-admin', {
    description: 'Create (or reset) an admin user. Use --force to act on a non-empty user base.',
    usage: '[--username name] [--force]',
    flags: [
      { name: '--username name', description: 'Username to create/reset (default: "admin")' },
      { name: '--force', description: 'Required if the user base is already non-empty - refuses to run without it' },
    ],
    examples: ['user create-admin', 'user create-admin --username root --force'],
    async handler({ flags }) {
      const username = typeof flags.username === 'string' ? flags.username : 'admin';
      const hasUsers = countUsers(db) > 0;
      const existing = findUserByUsername(db, username);

      if (hasUsers && flags.force !== true) {
        // eslint-disable-next-line no-console
        console.error(
          'Users already exist. Refusing to create/reset an admin without --force ' +
            '(this command is a recovery tool, not for routine use).'
        );
        return 1;
      }

      const tempPassword = generateTempPassword();
      const passwordHash = await hashPassword(tempPassword);

      if (existing) {
        updatePasswordHash(db, existing.id, passwordHash, { clearMustChange: false });
      } else {
        createUser(db, { username, passwordHash, role: 'admin', mustChangePassword: true });
      }

      // eslint-disable-next-line no-console
      console.log(
        `${existing ? 'Reset password for' : 'Created'} admin user "${username}".\n` +
          `Temporary password: ${tempPassword}\n` +
          `(must be changed on first login)`
      );
      return 0;
    },
  });

  // `app user reset-password <username>` - the general-purpose recovery
  // command for ANY existing user (create-admin above is specifically
  // for the admin account / first-run recovery case). Unlike
  // create-admin, this never creates a user - resetting a password for
  // a username that doesn't exist is almost certainly a typo, not an
  // intent to create an account, so it fails rather than silently
  // creating one.
  //
  // NOTE: `app user unlock` (§4.1) is NOT implemented here - there is no
  // failed-login-attempt tracking or account-lockout mechanism anywhere
  // in core/auth to unlock. Adding this command would be a facade with
  // nothing behind it; it needs a real lockout feature in core/auth
  // first, not a CLI stub.
  cli.command('user reset-password', {
    description: "Reset an existing user's password to a random temporary one",
    usage: '<username>',
    examples: ['user reset-password alice'],
    async handler({ positionals }) {
      const username = positionals[0];
      if (!username) {
        // eslint-disable-next-line no-console
        console.error('Usage: user reset-password <username>');
        return 2;
      }

      const existing = findUserByUsername(db, username);
      if (!existing) {
        // eslint-disable-next-line no-console
        console.error(`No such user: "${username}"`);
        return 1;
      }

      const tempPassword = generateTempPassword();
      const passwordHash = await hashPassword(tempPassword);
      if (userAdmin) {
        // stores the hash, forces a change and signs the user out everywhere
        userAdmin.resetUserPassword(db, existing.id, passwordHash);
      } else {
        updatePasswordHash(db, existing.id, passwordHash, { clearMustChange: false });
      }
      record('user.password_reset', existing);

      // eslint-disable-next-line no-console
      console.log(
        `Reset password for "${username}".\n` + `Temporary password: ${tempPassword}\n` + `(must be changed on first login${userAdmin ? '; every session of this user was ended' : ''})`
      );
      return 0;
    },
  });

  if (userAdmin) {
    const say = (text) => console.log(text); // eslint-disable-line no-console
    const fail = (text, code = 1) => {
      console.error(text); // eslint-disable-line no-console
      return code;
    };
    const needUser = (username) => {
      const user = username ? findUserByUsername(db, username) : null;
      return user ?? null;
    };
    /** Runs an operation, turning a UserAdminError into a message and exit code 1. */
    const guarded = async (fn) => {
      try {
        return await fn();
      } catch (err) {
        if (err?.name === 'UserAdminError') return fail(`Error (${err.code}): ${err.message}`);
        throw err;
      }
    };

    cli.command('user list', {
      description: 'List accounts (never prints password hashes or secrets)',
      usage: '[--search text] [--role name] [--disabled] [--limit n] [--json]',
      flags: [
        { name: '--search text', description: 'Match username or e-mail (plain text, case-insensitive)' },
        { name: '--role name', description: 'Only this role' },
        { name: '--disabled', description: 'Only disabled accounts' },
        { name: '--limit n', description: 'At most n rows (default 50, max 200)' },
        { name: '--json', description: 'Print JSON instead of a table' },
      ],
      examples: ['user list', 'user list --role admin', 'user list --search ivan --json'],
      handler({ flags }) {
        const result = userAdmin.listUsers(db, {
          search: typeof flags.search === 'string' ? flags.search : undefined,
          role: typeof flags.role === 'string' ? flags.role : undefined,
          disabled: flags.disabled ? true : undefined,
          limit: flags.limit,
        });
        if (flags.json) {
          say(JSON.stringify(result));
          return 0;
        }
        if (result.items.length === 0) {
          say('No matching users.');
          return 0;
        }
        for (const u of result.items) {
          say(
            `  #${u.id}  ${u.username}  ${u.role}  ${u.disabled ? 'DISABLED' : 'active'}  mfa:${u.activeAuthenticators}` +
              `${u.mustChangePassword ? '  must-change-password' : ''}  ${u.email ?? ''}`.trimEnd()
          );
        }
        say(`${result.items.length} of ${result.total}`);
        return 0;
      },
    });

    cli.command('user create', {
      description: 'Create an account with a random temporary password (must be changed at first login)',
      usage: '<username> [--role name] [--email address]',
      flags: [
        { name: '--role name', description: `Role (default: operator${roles ? `; one of ${roles.join(', ')}` : ''})` },
        { name: '--email address', description: 'E-mail address (needed for e-mailed password resets)' },
      ],
      examples: ['user create ivan.petrov', 'user create anna --role admin --email anna@example.com'],
      async handler({ positionals, flags }) {
        const username = positionals[0];
        if (!username) return fail('Usage: user create <username> [--role name] [--email address]', 2);
        return guarded(async () => {
          const tempPassword = generateTempPassword();
          const user = userAdmin.createManagedUser(db, {
            username,
            email: typeof flags.email === 'string' ? flags.email : null,
            role: typeof flags.role === 'string' ? flags.role : 'operator',
            passwordHash: await hashPassword(tempPassword),
            allowedRoles: roles,
          });
          record('user.create', user, { role: user.role });
          say(`Created "${user.username}" (${user.role}).\nTemporary password: ${tempPassword}\n(must be changed on first login)`);
          return 0;
        });
      },
    });

    cli.command('user rename', {
      description: "Change a user's login (their other sessions are ended)",
      usage: '<username> <new-username>',
      examples: ['user rename ivan ivan.petrov'],
      handler({ positionals }) {
        const [username, next] = positionals;
        if (!username || !next) return fail('Usage: user rename <username> <new-username>', 2);
        const user = needUser(username);
        if (!user) return fail(`No such user: "${username}"`);
        return guarded(() => {
          const r = userAdmin.renameUser(db, user.id, next);
          record('user.rename', user, { from: username, to: next });
          say(`Renamed "${username}" to "${r.user.username}"${r.revokedSessions ? ` (${r.revokedSessions} session(s) ended)` : ''}.`);
          return 0;
        });
      },
    });

    cli.command('user set-role', {
      description: "Change a user's role (their sessions are ended; the last active admin cannot be demoted)",
      usage: '<username> <role>',
      examples: ['user set-role anna admin'],
      handler({ positionals }) {
        const [username, role] = positionals;
        if (!username || !role) return fail('Usage: user set-role <username> <role>', 2);
        const user = needUser(username);
        if (!user) return fail(`No such user: "${username}"`);
        return guarded(() => {
          const r = userAdmin.changeUserRole(db, user.id, role, { adminRole, allowedRoles: roles });
          if (r.changed) record('user.set_role', user, { from: user.role, to: role });
          say(r.changed ? `"${username}" is now ${role}.` : `"${username}" already has the role ${role}.`);
          return 0;
        });
      },
    });

    cli.command('user set-email', {
      description: "Set or clear (--clear) a user's e-mail address",
      usage: '<username> <address> | <username> --clear',
      flags: [{ name: '--clear', description: 'Remove the address' }],
      examples: ['user set-email anna anna@example.com', 'user set-email anna --clear'],
      handler({ positionals, flags }) {
        const [username, address] = positionals;
        if (!username || (!address && !flags.clear)) return fail('Usage: user set-email <username> <address> | <username> --clear', 2);
        const user = needUser(username);
        if (!user) return fail(`No such user: "${username}"`);
        return guarded(() => {
          const u = userAdmin.setUserEmail(db, user.id, flags.clear ? null : address);
          record('user.set_email', user, { cleared: !u.email });
          say(u.email ? `E-mail of "${username}" set to ${u.email}.` : `E-mail of "${username}" cleared.`);
          return 0;
        });
      },
    });

    for (const [name, disable] of [['disable', true], ['enable', false]]) {
      cli.command(`user ${name}`, {
        description: disable
          ? "Block a user's login and end all their sessions (the last active admin cannot be disabled)"
          : "Allow a disabled user to log in again",
        usage: '<username>',
        examples: [`user ${name} ivan`],
        handler({ positionals }) {
          const username = positionals[0];
          if (!username) return fail(`Usage: user ${name} <username>`, 2);
          const user = needUser(username);
          if (!user) return fail(`No such user: "${username}"`);
          return guarded(() => {
            const r = userAdmin.setUserDisabled(db, user.id, disable, { adminRole });
            if (r.changed) record(disable ? 'user.disable' : 'user.enable', user);
            say(r.changed ? `"${username}" ${disable ? 'disabled' : 'enabled'}.` : `"${username}" is already ${disable ? 'disabled' : 'enabled'}.`);
            return 0;
          });
        },
      });
    }

    cli.command('user delete', {
      description: 'Remove an account: anonymised by default (row kept, login dead); --hard deletes it for good',
      usage: '<username> --yes [--hard]',
      flags: [
        { name: '--yes', description: 'Required: confirms the removal' },
        { name: '--hard', description: 'Delete the row instead of anonymising it (only where the law requires it)' },
      ],
      examples: ['user delete ivan --yes', 'user delete ivan --yes --hard'],
      handler({ positionals, flags }) {
        const username = positionals[0];
        if (!username) return fail('Usage: user delete <username> --yes [--hard]', 2);
        if (flags.yes !== true) return fail('Refusing to remove an account without --yes.', 2);
        const user = needUser(username);
        if (!user) return fail(`No such user: "${username}"`);
        return guarded(() => {
          const r = userAdmin.removeUser(db, user.id, { mode: flags.hard === true ? 'delete' : 'anonymize', adminRole });
          record('user.delete', user, { mode: r.mode });
          say(`${r.mode === 'delete' ? 'Deleted' : 'Anonymised'} "${username}".`);
          return 0;
        });
      },
    });
  }

  // Three admin recovery commands for the multi-authenticator model
  // (core/auth/authenticators.js, core/auth/recovery-codes.js), added
  // alongside the password ones above for the same reason they exist:
  // an admin needs a way to help a locked-out user (lost phone, lost
  // recovery-code sheet) without that user needing self-service UI,
  // which doesn't exist yet (Workshop Stage B, not started).

  if (listAuthenticators) {
    cli.command('user authenticators', {
      description: "List a user's authenticators",
      usage: '<username> [--json]',
      flags: [{ name: '--json', description: 'Print the list as JSON instead of a table' }],
      examples: ['user authenticators alice', 'user authenticators alice --json'],
      handler({ positionals, flags }) {
        const username = positionals[0];
        if (!username) {
          // eslint-disable-next-line no-console
          console.error('Usage: user authenticators <username>');
          return 2;
        }
        const user = findUserByUsername(db, username);
        if (!user) {
          // eslint-disable-next-line no-console
          console.error(`No such user: "${username}"`);
          return 1;
        }

        const list = listAuthenticators(db, user.id);
        if (flags.json) {
          // eslint-disable-next-line no-console
          console.log(JSON.stringify(list));
        } else if (list.length === 0) {
          // eslint-disable-next-line no-console
          console.log(`"${username}" has no authenticators.`);
        } else {
          for (const a of list) {
            // eslint-disable-next-line no-console
            console.log(`  #${a.id}  ${a.type}  ${a.status}  ${a.name ?? '(unnamed)'}  last used: ${a.lastUsedAt ?? 'never'}`);
          }
        }
        return 0;
      },
    });
  }

  if (removeAuthenticator) {
    cli.command('user authenticators-remove', {
      description: "Force-remove one of a user's authenticators - protected against removing their last one by default",
      usage: '<username> <id> [--force]',
      flags: [{ name: '--force', description: "Override the \"last factor\" protection" }],
      examples: ['user authenticators-remove alice 3', 'user authenticators-remove alice 3 --force'],
      handler({ positionals, flags }) {
        const [username, idStr] = positionals;
        if (!username || !idStr) {
          // eslint-disable-next-line no-console
          console.error('Usage: user authenticators-remove <username> <id> [--force]');
          return 2;
        }
        const user = findUserByUsername(db, username);
        if (!user) {
          // eslint-disable-next-line no-console
          console.error(`No such user: "${username}"`);
          return 1;
        }

        // Protected (mfaRequired: true) UNLESS --force - §18's
        // "can't remove the last factor" is exactly the safety rail an
        // admin fat-fingering this command benefits from too; --force
        // is the deliberate override for "yes, I know, they're
        // re-enrolling right now".
        const result = removeAuthenticator(db, user.id, Number(idStr), { mfaRequired: flags.force !== true });

        if (!result.ok) {
          // eslint-disable-next-line no-console
          console.error(
            result.reason === 'last_required_factor'
              ? `Refusing to remove authenticator #${idStr}: it's "${username}"'s last one. Re-run with --force to override.`
              : `No authenticator #${idStr} for "${username}".`
          );
          return 1;
        }

        // eslint-disable-next-line no-console
        console.log(`Removed authenticator #${idStr} from "${username}".`);
        return 0;
      },
    });
  }

  if (generateRecoveryCodes) {
    cli.command('user recovery-codes', {
      description: "Generate (or regenerate) a user's recovery codes - invalidates any existing set",
      usage: '<username> [--count n]',
      flags: [{ name: '--count n', description: 'How many codes to generate (default: 8)' }],
      examples: ['user recovery-codes alice', 'user recovery-codes alice --count 10'],
      async handler({ positionals, flags }) {
        const username = positionals[0];
        if (!username) {
          // eslint-disable-next-line no-console
          console.error('Usage: user recovery-codes <username> [--count n]');
          return 2;
        }
        const user = findUserByUsername(db, username);
        if (!user) {
          // eslint-disable-next-line no-console
          console.error(`No such user: "${username}"`);
          return 1;
        }

        const count = flags.count ? Number(flags.count) : 8;
        const codes = await generateRecoveryCodes(db, user.id, { count });

        // eslint-disable-next-line no-console
        console.log(`New recovery codes for "${username}" (previous set, if any, is now invalid):\n` + codes.join('\n'));
        return 0;
      },
    });
  }
}
