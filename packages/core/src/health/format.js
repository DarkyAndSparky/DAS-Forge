const ICONS = { ok: '✓', warn: '!', fail: '✗' };

/**
 * Human-readable report, the `app doctor` default (no --json). Mirrors
 * the architecture doc's §4.5 sample layout: title, one block per
 * category, one line per check, a one-line summary at the end.
 */
export function formatDoctorText(result, { title = 'Doctor', lang = 'en' } = {}) {
  const lines = [title, ''];

  for (const category of result.categories) {
    lines.push(category.name);
    for (const check of category.checks) {
      const icon = ICONS[check.status] ?? '?';
      lines.push(`  ${icon} ${check.name}: ${check.message}`);
    }
    lines.push('');
  }

  const { warn, fail } = result.summary;
  if (lang === 'ru') {
    if (fail > 0) lines.push(`Найдено проблем: ${fail}${warn > 0 ? `, предупреждений: ${warn}` : ''}.`);
    else if (warn > 0) lines.push(`Все проверки пройдены, предупреждений для просмотра: ${warn}.`);
    else lines.push('Все проверки пройдены.');
  } else if (fail > 0) {
    lines.push(`${fail} issue(s) found${warn > 0 ? `, ${warn} warning(s)` : ''}.`);
  } else if (warn > 0) {
    lines.push(`All checks passed, ${warn} warning(s) to review.`);
  } else {
    lines.push('All checks passed.');
  }

  return lines.join('\n');
}

/** `app doctor --json` / a future admin-panel fetch - same structure, machine-readable. */
export function formatDoctorJson(result) {
  return JSON.stringify(result, null, 2);
}
