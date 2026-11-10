import { ui } from '@das-forge/core';

/**
 * The start-up banner printed to the console once the server listens: versions, where to open it and, on the very
 * first start, the administrator's login and temporary password (the same ones that go into first-run-admin.txt),
 * each line in Russian and English. DAS_BOOTSTRAP_PRINT=false keeps the password out of the console.
 *
 * `wordmark: false` leaves the "DAS FORGE" lettering out (the live console keeps it pinned at the bottom).
 * Pure: returns the text, the caller prints it.
 */
export function formatStartBanner({ name = 'Workshop', appVersion = null, coreVersion = null, url, adminUrls = null, bootstrap = null, credentialsFile = null, showPassword = true, wordmark = true } = {}) {
  const rows = [
    `${name}${appVersion ? ` ${appVersion}` : ''}${coreVersion ? `  ·  DAS-Forge core ${coreVersion}` : ''}`,
    'запущен / started',
    '',
    `адрес / address:        ${url}`,
    `вход / sign in:         ${url}/login`,
    ...(adminUrls?.length
      ? [`админка / admin panel:  ${adminUrls[0]}/admin`, ...adminUrls.slice(1).map((u) => `                        ${u}/admin`), '(только на этом порту / on this port only)']
      : [`админка / admin panel:  ${url}/admin`]),
  ];
  if (bootstrap?.created) {
    rows.push('', 'Первый запуск — создан администратор / First run — administrator created:', '');
    rows.push(`  логин / login:       ${bootstrap.username}`);
    rows.push(`  пароль / password:   ${showPassword ? bootstrap.tempPassword : '(скрыт / hidden: DAS_BOOTSTRAP_PRINT=false)'}`);
    rows.push('', 'Пароль временный: после первого входа сразу попросят задать свой; старый вводить повторно не придётся.');
    rows.push('', 'The password is temporary: right after the first sign-in you will be asked to set your own, without typing this one again.');
    if (credentialsFile) rows.push('', `файл / file: ${credentialsFile}`);
  } else if (credentialsFile) {
    rows.push('', 'Забыли пароль администратора / forgot the admin password:', '  npm run cli -- user reset-password admin');
  }
  // long sentences wrap so the box fits a default 120-column console (paths and addresses stay whole)
  const wrapped = rows.flatMap((r) => {
    if ([...r].length <= 76) return [r];
    const lines = [];
    let cur = '';
    for (const word of r.split(' ')) {
      if ([...(cur ? `${cur} ${word}` : word)].length > 76 && cur) { lines.push(cur); cur = word; } else cur = cur ? `${cur} ${word}` : word;
    }
    if (cur) lines.push(cur);
    return lines;
  });
  rows.length = 0;
  rows.push(...wrapped);
  return ui.renderBanner(rows, { wordmark });
}
