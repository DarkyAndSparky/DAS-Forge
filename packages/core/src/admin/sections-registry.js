import { pickTexts } from '../i18n/overrides.js';
import { formatProcessingRegistry } from '../privacy/registry.js';
import { log } from '../audit/log.js';
import { contextFromRequest } from '../audit/context.js';
import { emptyRow } from './sections.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const REGISTRY_TEXTS = {
  ru: {
    registry: 'Реестр обработки',
    hint: 'Какие персональные данные обрабатывает приложение, зачем, на каком основании и как долго они хранятся. Записи платформы собираются из настроек, записи модулей — из их описаний. Основание обработки для данных платформы определяет владелец приложения.',
    name: 'Что обрабатывается', purpose: 'Цель', data: 'Данные', basis: 'Основание', retention: 'Срок хранения', erasure: 'Удаление',
    gaps: 'Модули без цели или основания обработки', none: 'Записей нет.', download: 'Скачать',
  },
  en: {
    registry: 'Processing register',
    hint: 'Which personal data the application processes, why, on what basis and for how long it is kept. Platform entries are built from the settings, module entries from their declarations. The legal basis for platform data is set by the application owner.',
    name: 'What is processed', purpose: 'Purpose', data: 'Data', basis: 'Legal basis', retention: 'Retention', erasure: 'Erasure',
    gaps: 'Modules without a purpose or legal basis', none: 'No entries.', download: 'Download',
  },
};

/**
 * "Processing register" section: the register of personal-data processing as a
 * table plus downloads (md, csv, json), built on every request from `build()`.
 */
export function mountRegistrySection({ app, db, guard, page, basePath, localeOf, texts = {}, build }) {
  const p = `${basePath}/registry`;
  const tx = (req) => pickTexts(REGISTRY_TEXTS, texts['admin-registry'], localeOf(req), 'admin-registry');

  app.get(p, ...guard, (req, res) => {
    const l = tx(req);
    const lang = localeOf(req) === 'en' ? 'en' : 'ru';
    const reg = build();
    const rows = reg.entries.map((e) => { const r = e[lang]; return `<tr><td>${esc(r.name)}</td><td>${esc(r.purpose)}</td><td>${esc(r.data)}</td><td>${esc(r.legalBasis)}</td><td>${esc(r.retention)}</td><td>${esc(r.erasure)}</td></tr>`; }).join('') || emptyRow(6, l.none);
    const gaps = reg.gaps.length ? `<div class="adm-toast" style="border-left-color:var(--adm-danger)">${esc(l.gaps)}: ${reg.gaps.map((g) => `<code>${esc(g)}</code>`).join(', ')}</div>` : '';
    const links = ['md', 'csv', 'json'].map((f) => `<a class="adm-btn" href="${p}.${f}">${esc(l.download)} ${f.toUpperCase()}</a>`).join(' ');
    page(req, res, { active: p, title: l.registry, bodyHtml: `<p class="adm-muted">${esc(l.hint)}</p>${gaps}<p>${links}</p><div class="adm-card"><table class="adm-table"><thead><tr><th>${esc(l.name)}</th><th>${esc(l.purpose)}</th><th>${esc(l.data)}</th><th>${esc(l.basis)}</th><th>${esc(l.retention)}</th><th>${esc(l.erasure)}</th></tr></thead><tbody>${rows}</tbody></table></div>` });
  });

  const types = { md: 'text/markdown', csv: 'text/csv', json: 'application/json' };
  for (const format of Object.keys(types)) {
    app.get(`${p}.${format}`, ...guard, (req, res) => {
      const lang = localeOf(req) === 'en' ? 'en' : 'ru';
      const text = formatProcessingRegistry(build(), { format, lang });
      log(db, { ...contextFromRequest(req), action: 'admin.registry.export', entity: 'registry', meta: { format, lang } });
      res.set('Content-Type', `${types[format]}; charset=utf-8`).set('Content-Disposition', `attachment; filename="processing-registry.${format}"`).set('Cache-Control', 'no-store').send(text);
    });
  }
}
