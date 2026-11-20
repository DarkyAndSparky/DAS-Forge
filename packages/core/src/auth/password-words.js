/**
 * The dictionary that ships with the core: passwords and bases that people choose over and over (English, Russian typed in
 * both layouts, keyboard walks, company-style defaults). It is the floor: an administrator can add words of their own and
 * connect a large leaked-password file, but nobody can switch this list off.
 *
 * A password is compared not only as typed but also with the usual disguises removed (see `dictionaryCandidates`): digits
 * and signs before and after the word, upper and lower case, and look-alike signs (`@` for a, `0` for o, `$` for s).
 * That is what makes a short list useful against a 12-character minimum: `Password2024!` is caught by `password`.
 */
export const BUILTIN_WORDS = Object.freeze([
  // the classics
  'password', 'passw0rd', 'passwort', 'pass', 'passcode', 'pa55word', 'p@ssw0rd', 'p@ssword', 'secret', 'letmein', 'welcome',
  'admin', 'administrator', 'adminadmin', 'root', 'toor', 'user', 'guest', 'login', 'changeme', 'default', 'master', 'test', 'testtest',
  'qwerty', 'qwertyuiop', 'qwertyui', 'qwerty123', 'qwertyuiopasdfghjkl', 'asdfgh', 'asdfghjkl', 'zxcvbn', 'zxcvbnm', 'azerty', 'qazwsx', 'qazwsxedc',
  'abc123', 'abcd1234', 'abcdefgh', 'abcdefghij', 'iloveyou', 'iloveu', 'monkey', 'dragon', 'football', 'baseball', 'basketball', 'hockey', 'soccer',
  'sunshine', 'princess', 'superman', 'batman', 'spiderman', 'starwars', 'pokemon', 'hunter', 'shadow', 'michael', 'jennifer', 'jordan', 'harley',
  'ranger', 'thomas', 'tigger', 'robert', 'daniel', 'andrew', 'joshua', 'charlie', 'maggie', 'buster', 'killer', 'pepper', 'summer', 'winter', 'spring', 'autumn',
  'freedom', 'whatever', 'trustno1', 'access', 'flower', 'hello', 'hellohello', 'lovely', 'mustang', 'cheese', 'computer', 'internet', 'service', 'system',
  'security', 'master123', 'letmein123', 'welcome123', 'monkey123', 'dragon123', 'football1', 'sunshine1', 'iloveyou1', 'password1', 'password12', 'password123',
  'password1234', 'passw0rd1', 'admin123', 'admin1234', 'administrator1', 'root123', 'user123', 'guest123', 'test123', 'qwe123', 'qweasd', 'qweasdzxc', 'qweqwe',
  'asdasd', 'asdasdasd', 'zxczxc', 'aaaaaa', 'aaaaaaaa', 'abcabc', 'abc12345', 'q1w2e3r4', 'q1w2e3r4t5', 'q1w2e3r4t5y6', '1q2w3e', '1q2w3e4r', '1q2w3e4r5t', '1q2w3e4r5t6y',
  '1qaz2wsx', '1qaz2wsx3edc', 'zaq12wsx', 'zaq1zaq1', 'zaq1xsw2', 'qazxsw', 'qazwsx123', 'poiuytrewq', 'lkjhgfdsa', 'mnbvcxz', 'asdfghjklqwerty',
  // numbers and walks
  '123456', '1234567', '12345678', '123456789', '1234567890', '12345678910', '123123', '123123123', '123321', '1234', '12345', '111111', '11111111', '1111111111',
  '000000', '00000000', '121212', '123qwe', '123abc', '1234qwer', '1234qwerasdf', '12341234', '12344321', '123454321', '147258369', '159753', '987654321', '987654',
  '654321', '87654321', '7777777', '777777', '666666', '555555', '222222', '112233', '101010', '696969', '131313', '246810', '135790', '0987654321', '1357924680',
  // years and seasons people append
  'summer2020', 'summer2021', 'summer2022', 'summer2023', 'summer2024', 'summer2025', 'summer2026', 'winter2024', 'winter2025', 'winter2026', 'spring2025', 'spring2026',
  'autumn2025', 'autumn2026', 'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  // company and IT defaults
  'company', 'companyname', 'office', 'work', 'workshop', 'manager', 'director', 'operator', 'support', 'helpdesk', 'servicedesk', 'database', 'server', 'network',
  'cisco', 'ubnt', 'huawei', 'mikrotik', 'oracle', 'postgres', 'mysql', 'sqlserver', 'windows', 'linux', 'ubuntu', 'debian', 'vmware', 'zabbix', 'nagios', 'backup',
  'temp', 'temp123', 'tempor', 'welcome1', 'welcome01', 'changeme1', 'changeme123', 'newpass', 'newpassword', 'oldpassword', 'mypassword', 'mypass', 'yourpassword',
  'passwordpassword', 'password!', 'letmein!', 'default1', 'initial', 'initial1', 'demo', 'sample', 'example', 'qwerty1', 'qwerty12', 'qwerty1234', 'qwerty12345',
  // Russian words and the same words typed in the English layout
  'пароль', 'пароль1', 'пароль123', 'парольпароль', 'привет', 'приветмир', 'админ', 'админадмин', 'администратор', 'сервис', 'работа', 'любовь', 'россия', 'москва',
  'йцукен', 'йцукенг', 'йцукенгшщзх', 'йцукенгшщ', 'фыва', 'фывапр', 'фывапролдж', 'ячсмить', 'qwertyйцукен', 'иванов', 'сергей', 'александр', 'дмитрий', 'андрей',
  'ghbdtn', 'ghbdtn1', 'ghbdtn123', 'gfhjkm', 'gfhjkm123', 'rfnfkjuf', 'ntcn', 'ntcnntcn', 'flvby', 'flvbyflvby', 'cthdbc', 'hjccbz', 'vjcrdf', 'ctyz', 'yfcnz',
  'qwertyuiop[]', 'qwerty123456', 'zaqxsw', 'zaqxswcde', 'zxcvbnm,.', 'qwertz', 'qwertzuiop', 'asdfjkl',
  // pop culture and sports
  'liverpool', 'chelsea', 'arsenal', 'barcelona', 'realmadrid', 'manutd', 'yankees', 'lakers', 'cowboys', 'steelers', 'ferrari', 'porsche', 'mercedes', 'bmw', 'audi',
  'matrix', 'naruto', 'nirvana', 'metallica', 'coffee', 'chocolate', 'banana', 'cookie', 'orange', 'purple', 'silver', 'golden', 'diamond', 'forever', 'angel', 'heaven',
  'baby', 'babygirl', 'sexy', 'lover', 'loveyou', 'love', 'lovelove', 'friend', 'family', 'mother', 'father', 'sister', 'brother', 'secret1', 'secret123',
]);

const LEET = { '@': 'a', '4': 'a', '8': 'b', '3': 'e', '6': 'g', '9': 'g', '!': 'i', '|': 'i', '0': 'o', '$': 's', '5': 's', '7': 't', '+': 't', '2': 'z' };
const MAX_LENGTH = 128;

const ALPHA_EDGES = /^[^\p{L}]+|[^\p{L}]+$/gu;

/**
 * Every plain form worth looking up for one typed password: lower case, without digits and signs at the edges, and with look-alike
 * signs turned back into letters (both readings of `1`, i and l).
 * @param {string} plain
 * @returns {string[]}
 */
export function dictionaryCandidates(plain) {
  const raw = String(plain ?? '').toLowerCase().normalize('NFKC');
  if (raw === '' || raw.length > MAX_LENGTH) return [];
  const out = new Set([raw]);
  const decode = (s, one) => [...s].map((c) => (c === '1' ? one : LEET[c] ?? c)).join('');
  for (const base of [raw, decode(raw, 'i'), decode(raw, 'l')]) {
    out.add(base);
    const stripped = base.replace(ALPHA_EDGES, '');
    if (stripped.length >= 4) out.add(stripped);
  }
  out.delete('');
  return [...out];
}

const BUILTIN_SET = new Set(BUILTIN_WORDS);

/**
 * True when the password is, or is only a disguised form of, a word of the list (the built-in one plus `extra`, which are
 * expected in lower case).
 * @param {string} plain
 * @param {Iterable<string>} [extra]
 */
export function matchesDictionary(plain, extra = []) {
  const extraSet = extra instanceof Set ? extra : new Set(extra);
  return dictionaryCandidates(plain).some((c) => BUILTIN_SET.has(c) || extraSet.has(c));
}

/** Where a password is found: `{ builtin, custom }` flags (for the "check a password" tool). */
export function dictionaryHits(plain, extra = []) {
  const extraSet = extra instanceof Set ? extra : new Set(extra);
  const cands = dictionaryCandidates(plain);
  return { builtin: cands.some((c) => BUILTIN_SET.has(c)), custom: cands.some((c) => extraSet.has(c)) };
}
