// AutoRoute: нормализация источников в правила, слияние по приоритету,
// версионирование сборок и откат. Плюс инвариант: датасетом, которым управляет
// AutoRoute, старое одноисточниковое зеркало больше не занимается.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = path.join(os.tmpdir(), `novpn-autoroute-${process.pid}-${Math.floor(process.hrtime()[1])}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.DATABASE_PATH = path.join(tmp, 'database.sqlite');
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.SESSION_SECRET = 'test';
process.env.SINGBOX_BIN = path.join(tmp, 'no-such-sing-box');

const { parseRuleLine, parseSource } = await import('../src/lib/routingRules.js');
const repo = await import('../src/repo.js');
const { seedIfEmpty } = await import('../src/seed.js');
const autoroute = await import('../src/services/autoroute.js');

seedIfEmpty();

function stubFetch(body: string, headers: Record<string, string> = {}) {
  (globalThis as any).fetch = async () => new Response(body, { status: 200, headers });
}

// ── нормализация строк ────────────────────────────────────────────────────────

test('parseRuleLine: префиксы Xray, CIDR, голый домен', () => {
  assert.deepEqual(parseRuleLine('example.com'), { kind: 'domain', value: 'example.com' });
  assert.deepEqual(parseRuleLine('domain:Example.COM'), { kind: 'domain', value: 'example.com' });
  assert.deepEqual(parseRuleLine('full:mail.example.com'), { kind: 'full', value: 'mail.example.com' });
  assert.deepEqual(parseRuleLine('keyword:Google'), { kind: 'keyword', value: 'google' });
  assert.deepEqual(parseRuleLine('regexp:^ad\\..*'), { kind: 'regexp', value: '^ad\\..*' });
  assert.deepEqual(parseRuleLine('10.0.0.0/8'), { kind: 'ip', value: '10.0.0.0/8' });
  assert.deepEqual(parseRuleLine('1.2.3.4'), { kind: 'ip', value: '1.2.3.4' });
  // wildcard/точка в начале — тот же домен
  assert.deepEqual(parseRuleLine('*.example.com'), { kind: 'domain', value: 'example.com' });
  assert.deepEqual(parseRuleLine('.example.com'), { kind: 'domain', value: 'example.com' });
  // схема, путь и порт срезаются
  assert.deepEqual(parseRuleLine('https://example.com/path?x=1'), { kind: 'domain', value: 'example.com' });
  assert.deepEqual(parseRuleLine('example.com:443'), { kind: 'domain', value: 'example.com' });
});

test('parseRuleLine: пропускаем комментарии, мусор и ссылки на чужие категории', () => {
  for (const bad of ['', '   ', '# комментарий', '// комментарий', '!блок', 'не домен', 'geosite:category-ru', 'geoip:ru']) {
    assert.equal(parseRuleLine(bad), null, `должно пропускаться: «${bad}»`);
  }
  // inline-комментарий отрезается, домен остаётся
  assert.deepEqual(parseRuleLine('example.com # почему-то'), { kind: 'domain', value: 'example.com' });
});

test('parseSource: sing-box rule-set, {items}, массив, построчный список', () => {
  const srs = JSON.stringify({
    version: 2,
    rules: [{ domain: ['a.com'], domain_suffix: ['b.com'], domain_keyword: ['kw'], ip_cidr: ['1.1.1.0/24'] }],
  });
  const r1 = parseSource(srs, true);
  assert.deepEqual(
    r1.rules.map((r) => `${r.kind}:${r.value}`).sort(),
    ['domain:b.com', 'full:a.com', 'ip:1.1.1.0/24', 'keyword:kw'],
  );

  const r2 = parseSource('{"items":["x.ru","y.ru"]}', true);
  assert.equal(r2.rules.length, 2);

  const r3 = parseSource('["x.ru","y.ru","x.ru"]', true);
  assert.equal(r3.rules.length, 2, 'дубликат схлопывается');
  assert.equal(r3.dups, 1);

  const r4 = parseSource('a.ru\n# c\n\nb.ru\na.ru\n', false);
  assert.equal(r4.rules.length, 2);
  assert.equal(r4.dups, 1);
  assert.ok(r4.skipped >= 2, 'комментарий и пустая строка пропущены');
});

// ── слияние по приоритету ─────────────────────────────────────────────────────

test('сборка: верхний источник побеждает в конфликте, одинаковое действие конфликтом не считается', async () => {
  const top = repo.addAutoRouteSource({ title: 'Верхний', url: 'https://src/top.lst', action: 'direct' });
  const mid = repo.addAutoRouteSource({ title: 'Средний', url: 'https://src/mid.lst', action: 'vpn' });
  const same = repo.addAutoRouteSource({ title: 'Такой же', url: 'https://src/same.lst', action: 'direct' });

  stubFetch('shared.ru\nonly-top.ru\n');
  await autoroute.refreshSource(top.id);
  stubFetch('shared.ru\nonly-mid.ru\n');
  await autoroute.refreshSource(mid.id);
  stubFetch('shared.ru\n');
  await autoroute.refreshSource(same.id);

  const res = autoroute.buildDataset();
  assert.equal(res.ok, true);
  assert.equal(res.build!.conflicts, 1, 'конфликт ровно один — sporный домен');
  assert.equal(res.conflicts[0]!.value, 'shared.ru');
  assert.equal(res.conflicts[0]!.winner.action, 'direct', 'победил верхний источник');
  assert.equal(res.conflicts[0]!.losers.length, 1, 'источник с ТЕМ ЖЕ действием в проигравшие не попал');

  // опубликованное содержимое = объединение без дублей
  const published = JSON.parse(repo.getRoutingContent('upstream') ?? '{}') as { items: string[] };
  assert.deepEqual(published.items.sort(), ['only-mid.ru', 'only-top.ru', 'shared.ru']);
});

test('приоритет меняется перестановкой — победитель конфликта меняется без повторного скачивания', () => {
  const sources = repo.listAutoRouteSources();
  const [top, mid] = sources;
  repo.reorderAutoRouteSources([mid!.id, top!.id, ...sources.slice(2).map((s) => s.id)]);
  const res = autoroute.buildDataset();
  assert.equal(res.conflicts[0]!.winner.action, 'vpn', 'теперь наверху источник с action=vpn');
  // приоритеты плотные: 0..N-1
  assert.deepEqual(
    repo.listAutoRouteSources().map((s) => s.priority),
    sources.map((_, i) => i),
  );
});

test('выключенный источник в сборку не попадает', async () => {
  const off = repo.addAutoRouteSource({ title: 'Выключенный', url: 'https://src/off.lst', action: 'vpn' });
  stubFetch('should-not-appear.ru\n');
  await autoroute.refreshSource(off.id);
  repo.updateAutoRouteSource(off.id, { enabled: false });
  autoroute.buildDataset();
  const published = JSON.parse(repo.getRoutingContent('upstream') ?? '{}') as { items: string[] };
  assert.equal(published.items.includes('should-not-appear.ru'), false);
});

// ── устойчивость ──────────────────────────────────────────────────────────────

test('источник недоступен → используется last-known-good, база не обедняется', async () => {
  const s = repo.addAutoRouteSource({ title: 'Падучий', url: 'https://src/flaky.lst', action: 'vpn' });
  stubFetch('keepme.ru\n');
  await autoroute.refreshSource(s.id);

  (globalThis as any).fetch = async () => {
    throw new Error('соединение сброшено');
  };
  const r = await autoroute.refreshSource(s.id);
  assert.equal(r.ok, false);
  assert.equal(repo.getAutoRouteSource(s.id)!.status, 'error');
  assert.equal(repo.getAutoRouteSource(s.id)!.ruleCount, 1, 'кеш не обнулился');

  autoroute.buildDataset();
  const published = JSON.parse(repo.getRoutingContent('upstream') ?? '{}') as { items: string[] };
  assert.ok(published.items.includes('keepme.ru'), 'правило из кеша осталось в сборке');
  repo.deleteAutoRouteSource(s.id);
});

test('резко похудевший источник отклоняется, прежний разбор сохраняется', async () => {
  const s = repo.addAutoRouteSource({ title: 'Обрезанный', url: 'https://src/shrink.lst', action: 'vpn' });
  stubFetch(Array.from({ length: 200 }, (_, i) => `d${i}.ru`).join('\n'));
  await autoroute.refreshSource(s.id);
  assert.equal(repo.getAutoRouteSource(s.id)!.ruleCount, 200);

  stubFetch('d1.ru\nd2.ru\n'); // 2 вместо 200
  const r = await autoroute.refreshSource(s.id);
  assert.equal(r.ok, false);
  assert.equal(repo.getAutoRouteSource(s.id)!.status, 'rejected');
  assert.equal(repo.getAutoRouteSource(s.id)!.ruleCount, 200, 'кеш остался прежним');
  repo.deleteAutoRouteSource(s.id);
});

test('смена URL обесценивает кеш и валидаторы условного GET', async () => {
  const s = repo.addAutoRouteSource({ title: 'Переезжающий', url: 'https://src/a.lst', action: 'vpn' });
  stubFetch('a.ru\n', { etag: 'W/"1"' });
  await autoroute.refreshSource(s.id);
  assert.equal(repo.getAutoRouteSource(s.id)!.ruleCount, 1);

  repo.updateAutoRouteSource(s.id, { url: 'https://src/b.lst' });
  const row = repo.getAutoRouteSourceRow(s.id);
  assert.equal(row.cached, null);
  assert.equal(row.etag, null);
  assert.equal(repo.getAutoRouteSource(s.id)!.ruleCount, null);
  repo.deleteAutoRouteSource(s.id);
});

// ── версии и откат ────────────────────────────────────────────────────────────

test('версии растут, откат возвращает прежнее содержимое и помечает версию опубликованной', async () => {
  const s = repo.addAutoRouteSource({ title: 'Версионируемый', url: 'https://src/v.lst', action: 'vpn' });
  stubFetch('v1-only.ru\n');
  await autoroute.refreshSource(s.id);
  const first = autoroute.buildDataset().build!;

  stubFetch('v1-only.ru\nv2-added.ru\n');
  await autoroute.refreshSource(s.id);
  const second = autoroute.buildDataset().build!;

  assert.equal(second.version, first.version + 1);
  assert.ok(second.added >= 1, 'diff посчитан относительно опубликованной версии');
  assert.ok((JSON.parse(repo.getRoutingContent('upstream')!) as { items: string[] }).items.includes('v2-added.ru'));

  const r = autoroute.rollbackTo('upstream', first.version);
  assert.equal(r.ok, true);
  const after = JSON.parse(repo.getRoutingContent('upstream')!) as { items: string[] };
  assert.equal(after.items.includes('v2-added.ru'), false, 'откат вернул содержимое старой версии');
  assert.equal(repo.getPublishedAutoRouteVersion('upstream'), first.version);

  assert.equal(autoroute.rollbackTo('upstream', 99999).ok, false, 'несуществующая версия — отказ');
  repo.deleteAutoRouteSource(s.id);
});

test('датасетом AutoRoute старое одноисточниковое зеркало не занимается', () => {
  repo.saveRoutingSource('upstream', { mode: 'mirror', sourceUrl: 'https://old/one.json', autoSync: true });
  const targets = repo.listRoutingSyncTargets().map((t) => t.name);
  assert.equal(targets.includes('upstream'), false, 'upstream исключён — им владеет AutoRoute');
});

test('сборка без включённых источников не публикует пустую базу', () => {
  for (const s of repo.listAutoRouteSources()) repo.deleteAutoRouteSource(s.id);
  const before = repo.getRoutingContent('upstream');
  const res = autoroute.buildDataset();
  assert.equal(res.ok, false);
  assert.equal(res.build, null);
  assert.equal(repo.getRoutingContent('upstream'), before, 'содержимое не тронуто');
});
