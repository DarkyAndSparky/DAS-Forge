
import { z } from 'zod';
import { accounts, http, ui, audit, branding } from '@das-forge/core';
import { renderHomeBody, renderNotesBody } from './pages.js';
import { translator } from './messages.js';
import { permissionsForRole } from './roles.js';
import { listNotes, createNote, deleteNote } from './notes.js';

const APP_NAME = 'My App';

// Validate every body with a schema: `http.validateBody(schema)` answers 400 with the field names, never a stack.
const NoteSchema = z.object({ body: z.string().trim().min(1).max(2000) });

/**
 * Wires the routes. Pattern for your own: `app.<verb>(path, http.requireAuth(), http.requirePermission('x'),
 * http.validateBody(Schema), handler)`; answer with `{ error: 'CODE', fields: [...] }` and a status, log what
 * happened with `logAudit`.
 */
export function registerRoutes(app, { db, authProvider, bans, appConfig, moduleRegistry, onLock = null, vendorIdentity = null, emailService = null, logger = null }) {
  const localeOf = (req) => (req.locale === 'en' ? 'en' : 'ru');
  const brandOf = () => ({ theme: branding.themeWithBranding(db, {}), html: branding.brandBlockHtml(db, vendorIdentity) });

  /** audit.log that pulls the request id and address out of the request and never breaks the request itself. */
  function logAudit(req, { actor, action, entity = null, entityId = null, result = 'success', meta = {} }) {
    try {
      audit.log(db, { actor, action, entity, entityId, result, meta, requestId: req.id, ip: req.ip });
    } catch { /* the audit trail must not take the request down */ }
  }

  /** One page inside the shell: menu, language, theme and footer are the same everywhere. */
  const appShell = (req, res, { activePath, title, bodyHtml }) => {
    const locale = localeOf(req);
    return ui.renderAppShell({
      moduleRegistry,
      viewerPermissions: req.user.permissions,
      user: req.user,
      nonce: res.locals?.cspNonce,
      bodyEndHtml: res.locals?.pageEnd?.(locale),
      bannerHtml: res.locals?.banner?.(locale) ?? '',
      locale,
      extraNav: [
        { path: '/ui', label: { ru: 'Главная', en: 'Home' } },
        { path: '/ui/notes', label: { ru: 'Заметки', en: 'Notes' }, permission: 'read:notes' },
        { path: '/admin', label: { ru: 'Администрирование', en: 'Admin panel' }, permission: 'admin.access' },
      ],
      theme: branding.themeWithBranding(db, {}),
      brandHtml: branding.brandBlockHtml(db, vendorIdentity),
      activePath,
      title: `${title} — ${APP_NAME}`,
      bodyHtml,
    });
  };

  // Sign-in, sign-out, /me, password change and reset by e-mail, own e-mail, TOTP and recovery codes: the core's
  // `accounts` module. Here: the role to permission policy and the sign-in page.
  accounts.mountAccountRoutes(app, {
    db, authProvider, appConfig, bans, onLock, emailService, logger, permissionsForRole,
    allowDuringPasswordChange: ['/ui', '/ui/password'],
    appName: APP_NAME, vendorIdentity, // the core draws the sign-in, password and reset pages; reword them with `texts`, replace one with `pages`
  });

  // --- Pages ---------------------------------------------------------------------------------------------
  app.get('/ui', http.requireAuth(), (req, res) => {
    res.type('html').send(appShell(req, res, { activePath: '/ui', title: APP_NAME, bodyHtml: renderHomeBody(req.user, localeOf(req)) }));
  });
  app.get('/ui/notes', http.requireAuth(), http.requirePermission('read:notes'), (req, res) => {
    const t = translator(localeOf(req));
    res.type('html').send(appShell(req, res, {
      activePath: '/ui/notes',
      title: t('notes.title'),
      bodyHtml: renderNotesBody({ nonce: res.locals?.cspNonce, locale: localeOf(req), canWrite: req.user.permissions.includes('write:notes') }),
    }));
  });

  // --- The example API: read for everyone signed in, write for those with the permission -------------------
  app.get('/notes', http.requireAuth(), http.requirePermission('read:notes'), (req, res) => {
    res.json(listNotes(db));
  });
  app.post('/notes', http.requireAuth(), http.requirePermission('write:notes'), http.validateBody(NoteSchema), (req, res) => {
    const note = createNote(db, { body: req.body.body, author: req.user.username });
    logAudit(req, { actor: req.user.username, action: 'note.create', entity: 'note', entityId: note.id });
    res.status(201).json(note);
  });
  app.delete('/notes/:id', http.requireAuth(), http.requirePermission('write:notes'), (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || !deleteNote(db, id)) return res.status(404).json({ error: 'NOT_FOUND', fields: [] });
    logAudit(req, { actor: req.user.username, action: 'note.delete', entity: 'note', entityId: id });
    res.json({ ok: true });
  });
}
