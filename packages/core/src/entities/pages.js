/**
 * HTML pages of one entity, built from its descriptor and store (ADR-0012, B2 part 2): a paged list with search,
 * a create form, an edit form (optimistic lock), delete and restore. The app gives the frame and the login:
 *
 *   mountEntityPages(app, { entity, store, getScope, render, basePath, csrfField, readForm })
 *     getScope(req)            scope from `tenancy.resolveScope` (null = not signed in -> 401)
 *     render(req, res, {title, bodyHtml})   puts the body into the app's page (shell) and sends it. `bodyHtml` is safe HTML
 *                              (everything from records is escaped); `title` is PLAIN TEXT (it can hold a record's value): the
 *                              app must escape it where it prints it, as `pageShell` does
 *     csrfField(req, res)      hidden input with the CSRF token (default: none; the app's own middleware may check it)
 *     readForm(req)            the posted form as an object of strings (default: req.body)
 *
 *   GET  {basePath}  list     GET {basePath}/new  form     POST {basePath}  create
 *   GET  {basePath}/:id edit  POST {basePath}/:id update   POST {basePath}/:id/delete   POST {basePath}/:id/restore
 *
 * Fields of a variant entity: the form shows the fields of the chosen case only; the case cannot be changed without a re-render.
 * `secret` fields are password inputs; an empty value on edit leaves the stored secret as it is.
 * Not rendered: `file` fields (their upload goes through the file store).
 */
import { EntityNotFoundError, EntityValidationError, EntityConflictError, TenantRequiredError } from './store.js';
import { TenantAccessError } from '../tenancy/index.js';
import { pageParams, pagerFor } from '../admin/paging.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const T = {
  ru: { search: 'Поиск', find: 'Найти', create: 'Создать', save: 'Сохранить', cancel: 'Назад к списку', del: 'Удалить', restore: 'Восстановить', edit: 'Изменить', none: 'Записей нет.', deleted: 'Удалена', showDeleted: 'Показать удалённые', yes: 'да', no: 'нет', keep: 'пусто — не менять', newTitle: 'Новая запись', conflict: 'Запись изменил кто-то другой или значение уже занято. Откройте её заново.', tenant: 'Выберите организацию, в которой создать запись.', errors: { required: 'Обязательное поле', type: 'Неверное значение', too_long: 'Слишком длинное', too_short: 'Слишком короткое', not_in_list: 'Нет в списке', too_small: 'Слишком мало', too_big: 'Слишком много', pattern: 'Неверный формат', unknown_field: 'Неизвестное поле', not_for_this_case: 'Не для этого вида', null_not_allowed: 'Не может быть пустым', read_only: 'Только чтение', too_many_decimals: 'Слишком много знаков' } },
  en: { search: 'Search', find: 'Find', create: 'Create', save: 'Save', cancel: 'Back to the list', del: 'Delete', restore: 'Restore', edit: 'Edit', none: 'No records.', deleted: 'Deleted', showDeleted: 'Show deleted', yes: 'yes', no: 'no', keep: 'empty — keep as is', newTitle: 'New record', conflict: 'Someone else changed the record, or the value is already taken. Open it again.', tenant: 'Choose an organization to create the record in.', errors: { required: 'Required', type: 'Wrong value', too_long: 'Too long', too_short: 'Too short', not_in_list: 'Not in the list', too_small: 'Too small', too_big: 'Too big', pattern: 'Wrong format', unknown_field: 'Unknown field', not_for_this_case: 'Not for this kind', null_not_allowed: 'Cannot be empty', read_only: 'Read only', too_many_decimals: 'Too many decimals' } },
};

const loc = (req) => (req.locale === 'en' ? 'en' : 'ru');
const labelOf = (f, l) => f.label?.[l] ?? f.label ?? f.name;

/** Form string -> API value for one field; `undefined` = leave it out. */
function parseInput(f, raw, { editing }) {
  if (Array.isArray(raw)) raw = raw[raw.length - 1]; // the hidden "0" before a checked box
  if (f.type === 'bool') return raw === '1' || raw === 'on' || raw === 'true';
  if (f.secret) return raw === '' || raw === undefined ? undefined : String(raw);
  const s = raw === undefined || raw === null ? '' : String(raw);
  if (s.trim() === '') return editing || f.nullable ? (f.nullable ? null : undefined) : undefined;
  if (f.type === 'int' || (f.type === 'ref' && f.idType !== 'text')) return /^-?\d+$/.test(s.trim()) ? Number(s.trim()) : s;
  if (f.type === 'money') { const m = /^(-?)(\d+)(?:[.,](\d{1,2}))?$/.exec(s.trim()); return m ? Number(`${m[1]}${m[2]}${(m[3] ?? '').padEnd(2, '0')}`) : s; }
  if (f.type === 'json') { try { return JSON.parse(s); } catch { return s; } }
  return s;
}

const shown = (f, v, t) => {
  if (v === null || v === undefined || v === '') return '';
  if (f.type === 'bool') return v ? t.yes : t.no;
  if (f.def.format) { try { return f.def.format(f.type === 'decimal' ? Number(String(v).replace('.', '')) : v, f); } catch { /* fall through */ } }
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
};

function inputFor(f, value, t, l, errs) {
  const name = `f_${f.name}`;
  const err = errs.find((e) => e.path === f.name);
  const msg = err ? `<span class="adm-error">${esc(t.errors[err.code] ?? err.code)}</span>` : '';
  const val = value === null || value === undefined ? '' : (f.type === 'json' ? JSON.stringify(value) : f.type === 'money' ? (value / 100).toFixed(2) : String(value));
  const req = f.required ? ' required' : '';
  let ctl;
  if (f.type === 'bool') ctl = `<input type="hidden" name="${name}" value="0"><input type="checkbox" name="${name}" value="1"${value ? ' checked' : ''}>`;
  else if (f.type === 'enum') ctl = `<select class="adm-input" name="${name}"${req}>${f.required ? '' : '<option value=""></option>'}${f.values.map((v) => `<option value="${esc(v)}"${v === value ? ' selected' : ''}>${esc(f.valueLabels?.[v]?.[l] ?? v)}</option>`).join('')}</select>`;
  else if (f.type === 'longText' || f.type === 'json') ctl = `<textarea class="adm-input" name="${name}" rows="4"${req}>${esc(val)}</textarea>`;
  else if (f.secret) ctl = `<input class="adm-input" type="password" name="${name}" autocomplete="new-password" placeholder="${esc(t.keep)}">`;
  else ctl = `<input class="adm-input" type="${f.type === 'date' ? 'date' : 'text'}" name="${name}" value="${esc(val)}"${f.max ? ` maxlength="${esc(f.max)}"` : ''}${req} autocomplete="off">`;
  return `<label class="adm-field">${esc(labelOf(f, l))}${f.required ? ' *' : ''}${ctl}${msg}</label>`;
}

export function mountEntityPages(app, { entity, store, getScope, render, basePath = `/${entity.table}`, csrfField = () => '', readForm = (req) => req.body }) {
  if (typeof getScope !== 'function' || typeof render !== 'function') throw new TypeError('mountEntityPages: getScope(req) and render(req, res, page) are required');
  const perms = entity.permissions ?? {};
  const tenanted = entity.tenant !== 'global';
  const allowedAnywhere = (s, p) => !p || s.all || (tenanted ? s.visibleTenantIds.some((x) => s.can(p, x)) : s.can(p));
  // the organizations where the person may read: the list query itself is limited to them, so `total` and the page count never count other organizations' records
  const readableTenants = (s, p) => (!tenanted || !p || s.all ? undefined : s.visibleTenantIds.filter((x) => s.can(p, x)));
  const allowedIn = (s, p, rec) => !p || s.all || (tenanted ? s.can(p, rec.tenantId) : s.can(p));
  const idOf = (req) => (entity.idType === 'int' ? Number(req.params.id) : String(req.params.id));
  const baseFields = Object.values(entity.fields).filter((f) => f.type !== 'file');
  const by = entity.variants?.by;
  const caseFields = (key) => (entity.variants && key && entity.variants.cases[key] ? Object.values(entity.variants.cases[key].fields).filter((f) => f.type !== 'file') : []);

  const wrap = (fn) => async (req, res) => {
    const l = loc(req); const t = T[l];
    try {
      const scope = await getScope(req);
      if (!scope) return res.status(401).send('401');
      return await fn(req, res, scope, l, t);
    } catch (e) {
      if (e instanceof EntityNotFoundError) return res.status(404).send('404');
      if (e instanceof TenantAccessError) return res.status(403).send('403');
      if (e instanceof EntityConflictError) return renderPage(req, res, entity.label[l][0], `<div role="alert" class="adm-card">${esc(t.conflict)}</div><p><a href="${basePath}">${esc(t.cancel)}</a></p>`, 409);
      if (e instanceof TenantRequiredError) return renderPage(req, res, entity.label[l][0], `<div role="alert" class="adm-card">${esc(t.tenant)}</div><p><a href="${basePath}">${esc(t.cancel)}</a></p>`, 400);
      throw e;
    }
  };
  const renderPage = (req, res, title, bodyHtml, status = 200) => { res.status(status); return render(req, res, { title, bodyHtml }); };

  function formHtml({ req, res, l, t, action, values, errs = [], version, record }) {
    const key = by ? values[by] : undefined;
    const fields = [...baseFields, ...caseFields(key)];
    const noCase = by && !key ? `<p class="adm-muted">${esc(labelOf(entity.fields[by], l))}: ${esc(t.errors.required)}</p>` : '';
    const csrf = csrfField(req, res) ?? '';
    const delForm = record && allowedIn(res.locals._scope, perms.delete, record) && !record.deletedAt
      ? `<form method="post" action="${basePath}/${esc(record.id)}/delete" style="margin-top:1rem">${csrf}<button class="adm-btn" type="submit">${esc(t.del)}</button></form>` : '';
    const resForm = record?.deletedAt && allowedIn(res.locals._scope, perms.restore ?? perms.delete, record)
      ? `<form method="post" action="${basePath}/${esc(record.id)}/restore" style="margin-top:1rem">${csrf}<button class="adm-btn" type="submit">${esc(t.restore)}</button></form>` : '';
    return `<form method="post" action="${action}" autocomplete="off">${csrf}${version !== undefined ? `<input type="hidden" name="_version" value="${esc(version)}">` : ''}
${fields.map((f) => inputFor(f, values[f.name] ?? values.attrs?.[f.name], t, l, errs)).join('\n')}${noCase}
${errs.filter((e) => !fields.some((f) => f.name === e.path)).map((e) => `<p class="adm-error">${esc(e.path)}: ${esc(t.errors[e.code] ?? e.code)}</p>`).join('')}
<p><button class="adm-btn primary" type="submit">${esc(t.save)}</button> <a class="adm-btn" href="${basePath}">${esc(t.cancel)}</a></p></form>${delForm}${resForm}`;
  }

  function collect(req, form) {
    const key = by ? String(form[`f_${by}`] ?? '') : undefined;
    const out = {};
    for (const f of [...baseFields, ...caseFields(key)]) {
      const raw = form[`f_${f.name}`];
      if (raw === undefined && f.type !== 'bool') continue;
      const v = parseInput(f, raw, { editing: req.__editing });
      if (v !== undefined) out[f.name] = v;
    }
    return out;
  }

  const scoped = (fn) => wrap(async (req, res, scope, l, t) => { res.locals ??= {}; res.locals._scope = scope; return fn(req, res, scope, l, t); });

  app.get(basePath, scoped(async (req, res, scope, l, t) => {
    if (!allowedAnywhere(scope, perms.read)) return res.status(403).send('403');
    const pg = pageParams(req);
    const q = typeof req.query?.q === 'string' ? req.query.q.slice(0, 200) : '';
    const withDeleted = req.query?.deleted === '1' && allowedAnywhere(scope, perms.restore ?? perms.delete);
    const out = await store.list(scope, { onlyTenants: readableTenants(scope, perms.read), page: pg.page, size: pg.size, q, includeDeleted: withDeleted });
    const items = out.items.filter((r) => allowedIn(scope, perms.read, r));
    const cols = entity.list.columns.map((c) => entity.fields[c]);
    const head = cols.map((f) => `<th>${esc(labelOf(f, l))}</th>`).join('');
    const rows = items.map((r) => `<tr>${cols.map((f, i) => `<td>${i === 0 ? `<a href="${basePath}/${esc(r.id)}">${esc(shown(f, r[f.name], t)) || esc(r.id)}</a>` : esc(shown(f, r[f.name], t))}</td>`).join('')}${withDeleted ? `<td>${r.deletedAt ? esc(t.deleted) : ''}</td>` : ''}</tr>`).join('');
    const canCreate = tenanted ? scope.all || scope.visibleTenantIds.some((x) => scope.can(perms.create, x)) : scope.can(perms.create);
    const body = `<form method="get" action="${basePath}" style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:flex-end;margin-bottom:1rem"><label class="adm-field" style="margin:0">${esc(t.search)}<input class="adm-input" name="q" value="${esc(q)}" maxlength="200"></label><button class="adm-btn" type="submit">${esc(t.find)}</button>${canCreate || !perms.create ? `<a class="adm-btn primary" href="${basePath}/new">${esc(t.create)}</a>` : ''}${allowedAnywhere(scope, perms.restore ?? perms.delete) ? `<a href="${basePath}${withDeleted ? '' : '?deleted=1'}">${esc(t.showDeleted)}</a>` : ''}</form>
${items.length ? `<table class="adm-table"><thead><tr>${head}${withDeleted ? '<th></th>' : ''}</tr></thead><tbody data-paged="ent-${esc(entity.name)}">${rows}</tbody></table>` : `<p class="adm-muted adm-empty">${esc(t.none)}</p>`}
${pagerFor({ req, res, path: basePath, name: `ent-${entity.name}`, ...pg, count: items.length, total: out.total, locale: l })}`;
    return renderPage(req, res, entity.label[l][1], body);
  }));

  app.get(`${basePath}/new`, scoped(async (req, res, scope, l, t) => {
    if (!allowedAnywhere(scope, perms.create)) return res.status(403).send('403');
    const preset = {}; if (by && typeof req.query?.[by] === 'string') preset[by] = req.query[by];
    for (const f of baseFields) if (f.default !== undefined && typeof f.default !== 'function' && preset[f.name] === undefined) preset[f.name] = f.default;
    return renderPage(req, res, t.newTitle, formHtml({ req, res, l, t, action: basePath, values: preset }));
  }));

  app.post(basePath, scoped(async (req, res, scope, l, t) => {
    if (!allowedIn(scope, perms.create, { tenantId: scope.activeTenantId })) return res.status(403).send('403');
    const form = (await readForm(req)) ?? {};
    const input = collect(req, form);
    try { await store.create(scope, input, { actor: scope.userId }); } catch (e) {
      if (e instanceof EntityValidationError) return renderPage(req, res, t.newTitle, formHtml({ req, res, l, t, action: basePath, values: input, errs: e.errors }), 422);
      throw e;
    }
    return res.redirect(303, basePath);
  }));

  app.get(`${basePath}/:id`, scoped(async (req, res, scope, l, t) => {
    const rec = await store.get(scope, idOf(req), { includeDeleted: true });
    if (!allowedIn(scope, perms.read, rec)) return res.status(404).send('404');
    const values = { ...rec, ...(rec.attrs ?? {}) };
    return renderPage(req, res, String(shown(entity.fields[entity.list.columns[0]], rec[entity.list.columns[0]], t) || rec.id), formHtml({ req, res, l, t, action: `${basePath}/${esc(rec.id)}`, values, version: rec.version, record: rec }));
  }));

  app.post(`${basePath}/:id`, scoped(async (req, res, scope, l, t) => {
    const id = idOf(req);
    const cur = await store.get(scope, id);
    if (!allowedIn(scope, perms.update, cur)) return res.status(403).send('403');
    const form = (await readForm(req)) ?? {};
    req.__editing = true;
    const input = collect(req, { ...form, ...(by ? { [`f_${by}`]: form[`f_${by}`] ?? cur[by] } : {}) });
    const v = form._version === undefined || form._version === '' ? undefined : Number(form._version);
    try { await store.update(scope, id, input, { expectedVersion: v, actor: scope.userId }); } catch (e) {
      if (e instanceof EntityValidationError) return renderPage(req, res, entity.label[l][0], formHtml({ req, res, l, t, action: `${basePath}/${esc(id)}`, values: { ...cur, ...input }, errs: e.errors, version: cur.version, record: cur }), 422);
      throw e;
    }
    return res.redirect(303, basePath);
  }));

  app.post(`${basePath}/:id/delete`, scoped(async (req, res, scope) => {
    const id = idOf(req); const cur = await store.get(scope, id);
    if (!allowedIn(scope, perms.delete, cur)) return res.status(403).send('403');
    await store.remove(scope, id, { actor: scope.userId });
    return res.redirect(303, basePath);
  }));

  app.post(`${basePath}/:id/restore`, scoped(async (req, res, scope) => {
    const id = idOf(req); const cur = await store.get(scope, id, { includeDeleted: true });
    if (!allowedIn(scope, perms.restore ?? perms.delete, cur)) return res.status(403).send('403');
    await store.restore(scope, id, { actor: scope.userId });
    return res.redirect(303, basePath);
  }));

  return { basePath };
}
