// Проверка «имена и импорты»: запускает tsc по JS-коду и считает ошибкой только то,
// что ловит настоящие баги: неизвестное имя, несуществующий экспорт, битый импорт.
// Остальные замечания по типам (их сотни, код не размечен типами) не считаются.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { countByModule, compareToBaseline } from './typecheck-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 2304/2552 нет такого имени, 2305/2724/2614 нет такого экспорта, 2307 не найден модуль,
// 1xxx синтаксис
const FAIL = new Set([2304, 2552, 2305, 2724, 2614, 2307, 2306, 2503]);

const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const r = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.typecheck.json', '--pretty', 'false'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
if (r.error) { console.error('Не удалось запустить tsc:', r.error.message); process.exit(2); }

const bad = [];
let total = 0;
for (const line of (r.stdout + r.stderr).split('\n')) {
  const m = /error TS(\d+):/.exec(line);
  if (!m) continue;
  total++;
  const code = Number(m[1]);
  if (code < 2000 || FAIL.has(code)) bad.push(line);
}
if (bad.length) {
  console.error(bad.join('\n'));
  console.error(`\ntypecheck: ${bad.length} ошибок (из ${total} замечаний tsc, остальные не считаются)`);
  process.exit(1);
}
// «Храповик» (E3): остальные замечания по типам не считаются ошибкой, но их число по модулям не должно расти.
// База лежит в scripts/typecheck-baseline.json; `npm run typecheck -- --update` записывает текущие числа.
const { byModule } = countByModule(r.stdout + r.stderr);
const BASELINE = path.join(root, 'scripts', 'typecheck-baseline.json');
if (process.argv.includes('--update')) {
  writeFileSync(BASELINE, `${JSON.stringify(byModule, null, 2)}\n`);
  console.log(`typecheck: база записана (${total} замечаний в ${Object.keys(byModule).length} модулях)`);
} else if (!existsSync(BASELINE)) {
  console.log(`typecheck: ok (замечаний по типам, не считающихся ошибкой: ${total}). Базы нет: запустите \`npm run typecheck -- --update\`, чтобы число по модулям не росло.`);
} else {
  const { worse, better } = compareToBaseline(byModule, JSON.parse(readFileSync(BASELINE, 'utf8')));
  if (worse.length) {
    for (const [m, was, now] of worse) console.error(`  БОЛЬШЕ: ${m} ${was} -> ${now}`);
    console.error('\ntypecheck: число замечаний по типам выросло. Новый код пишите с типами (JSDoc); если рост оправдан, `npm run typecheck -- --update`.');
    process.exit(1);
  }
  for (const [m, was, now] of better) console.log(`  меньше: ${m} ${was} -> ${now}`);
  console.log(`typecheck: ok (замечаний ${total}, ни в одном модуле не больше базы${better.length ? `; улучшено модулей: ${better.length}, обновите базу --update` : ''})`);
}
