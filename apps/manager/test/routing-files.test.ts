// Умная маршрутизация: разбор структуры/diff, версионирование при сохранении,
// и защита автообновления зеркала (last-known-good): битый JSON, смена структуры,
// подозрительное сжатие — НЕ применяются; идентичное — не растит версию.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = path.join(os.tmpdir(), `novpn-routing-${process.pid}-${Math.floor(process.hrtime()[1])}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.DATABASE_PATH = path.join(tmp, 'database.sqlite');
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.SESSION_SECRET = 'test';
// Заведомо отсутствующий бинарник sing-box → детерминированный «binary не найден».
process.env.SINGBOX_BIN = path.join(tmp, 'no-such-sing-box');

const { analyzeShape, diffCounts, normalizeJson } = await import('../src/lib/routingJson.js');
const { detectSourceFormat, convertList } = await import('../src/lib/routingConvert.js');
const repo = await import('../src/repo.js');
const { seedIfEmpty } = await import('../src/seed.js');
const { checkMirror } = await import('../src/services/routingSync.js');

seedIfEmpty();

// Стаб глобального fetch: подменяем на нужный ответ в каждом тесте.
function stubFetch(status: number, body: string, headers: Record<string, string> = {}) {
  (globalThis as any).fetch = async () => new Response(status === 304 ? null : body, { status, headers });
}

const bigList = (n: number) => JSON.stringify({ items: Array.from({ length: n }, (_, i) => `d${i}.example`) });

test('analyzeShape: массив, объект-с-items, объект-map, мусор', () => {
  assert.deepEqual(analyzeShape('[1,2,3]').count, 3);
  assert.equal(analyzeShape('[1,2,3]').rootType, 'array');
  assert.equal(analyzeShape('{"items":["a","b"]}').count, 2);
  assert.equal(analyzeShape('{"items":["a","b"]}').rootType, 'object');
  assert.equal(analyzeShape('{"a":1,"b":2,"c":3}').count, 3); // ключи как элементы
  assert.equal(analyzeShape('not json').rootType, 'other');
  assert.equal(analyzeShape('not json').count, null);
});

test('diffCounts + normalizeJson', () => {
  const a = analyzeShape('{"items":["a","b","c"]}').entries;
  const b = analyzeShape('{"items":["b","c","d","e"]}').entries;
  assert.deepEqual(diffCounts(a, b), { added: 2, removed: 1 });
  assert.deepEqual(diffCounts(null, b), { added: null, removed: null });
  assert.equal(normalizeJson('{ "x":1 }'), normalizeJson('{"x":1}')); // форматирование игнор
});

test('saveRoutingContent: версия растёт только при реальном изменении', () => {
  const first = repo.saveRoutingContent('sites', '{\n  "items": ["a.ru"]\n}');
  assert.equal(first.changed, true);
  const v = first.meta.version;
  const again = repo.saveRoutingContent('sites', '{\n  "items": ["a.ru"]\n}'); // тот же текст
  assert.equal(again.changed, false);
  assert.equal(again.meta.version, v); // без bump
  const changed = repo.saveRoutingContent('sites', '{\n  "items": ["a.ru","b.ru"]\n}');
  assert.equal(changed.changed, true);
  assert.equal(changed.meta.version, v + 1);
  assert.equal(changed.meta.entryCount, 2);
});

test('checkMirror auto: применяет валидное большое обновление', async () => {
  repo.saveRoutingContent('upstream', bigList(100));
  repo.saveRoutingSource('upstream', { mode: 'mirror', sourceUrl: 'https://src/upstream.json', autoSync: true });
  const before = repo.getRoutingFull('upstream')!;
  stubFetch(200, bigList(140), { etag: 'W/"abc"' });
  const r = await checkMirror('upstream', { apply: true });
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.equal(r.status, 'ok');
  const after = repo.getRoutingFull('upstream')!;
  assert.equal(after.version, before.version + 1);
  assert.equal(after.entryCount, 140);
  assert.equal(after.status, 'ok');
});

test('checkMirror auto: подозрительное сжатие ОТКЛОНЯЕТСЯ (last-known-good)', async () => {
  repo.saveRoutingContent('apps', bigList(12483));
  repo.saveRoutingSource('apps', { mode: 'mirror', sourceUrl: 'https://src/apps.json', autoSync: true });
  const before = repo.getRoutingFull('apps')!;
  stubFetch(200, bigList(317)); // 317 << 50% от 12483
  const r = await checkMirror('apps', { apply: true });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'rejected');
  const after = repo.getRoutingFull('apps')!;
  assert.equal(after.version, before.version); // содержимое не тронуто
  assert.equal(after.entryCount, 12483);
  assert.match(after.statusReason, /12483.*317/);
});

test('checkMirror auto: смена корневой структуры ОТКЛОНЯЕТСЯ', async () => {
  repo.saveRoutingContent('sites', bigList(50)); // объект {items:[]}
  repo.saveRoutingSource('sites', { mode: 'mirror', sourceUrl: 'https://src/sites.json', autoSync: true });
  const before = repo.getRoutingFull('sites')!;
  stubFetch(200, JSON.stringify(['a', 'b', 'c'])); // массив
  const r = await checkMirror('sites', { apply: true });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'rejected');
  assert.equal(repo.getRoutingFull('sites')!.version, before.version);
});

test('checkMirror auto: битый JSON — ошибка, версия не растёт', async () => {
  const before = repo.getRoutingFull('sites')!;
  stubFetch(200, '{ broken json,,,');
  const r = await checkMirror('sites', { apply: true });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'error');
  assert.equal(repo.getRoutingFull('sites')!.version, before.version);
});

test('checkMirror manual (apply=false): не публикует, возвращает content', async () => {
  repo.saveRoutingContent('upstream', bigList(100));
  repo.saveRoutingSource('upstream', { mode: 'mirror', sourceUrl: 'https://src/upstream.json', autoSync: false });
  const before = repo.getRoutingFull('upstream')!;
  stubFetch(200, bigList(120));
  const r = await checkMirror('upstream', { apply: false });
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.ok(r.content && r.content.length > 0);
  const after = repo.getRoutingFull('upstream')!;
  assert.equal(after.version, before.version); // НЕ опубликовано
});

test('checkMirror: 304 Not Modified — без изменений', async () => {
  repo.saveRoutingSource('upstream', { mode: 'mirror', sourceUrl: 'https://src/upstream.json', autoSync: true });
  const before = repo.getRoutingFull('upstream')!;
  stubFetch(304, '');
  const r = await checkMirror('upstream', { apply: true });
  assert.equal(r.changed, false);
  assert.equal(r.status, 'nochange');
  assert.equal(repo.getRoutingFull('upstream')!.version, before.version);
});

// ── форматы источника ──

test('detectSourceFormat: по расширению URL', () => {
  assert.equal(detectSourceFormat('https://x/a.json'), 'json');
  assert.equal(detectSourceFormat('https://x/a.lst'), 'lst');
  assert.equal(detectSourceFormat('https://x/a.txt?v=2'), 'txt');
  assert.equal(detectSourceFormat('https://x/a.srs#frag'), 'srs');
  assert.equal(detectSourceFormat('https://x/no-ext'), 'json'); // неизвестное → json
});

test('convertList: нормализация + статистика (пустые/комменты/схема/путь/дубли/lowercase)', () => {
  const raw = [
    '# заголовок-комментарий',
    '// ещё комментарий',
    '',
    '  YouTube.com  ', // trim + lowercase
    'https://Example.com/path?x=1#h', // схема + путь/квери/хэш
    'example.com', // дубль (после нормализации https://Example.com → example.com)
    'discord.com # inline-коммент',
    'не валид с пробелом',
    'ok.ru',
  ].join('\n');
  const c = convertList(raw);
  assert.deepEqual(c.items, ['youtube.com', 'example.com', 'discord.com', 'ok.ru']);
  assert.equal(c.lines, 9);
  assert.equal(c.dups, 1); // example.com встретился дважды
  assert.equal(c.skipped, 4); // 2 коммент-строки + пустая + «не валид с пробелом»
  assert.equal(c.valid, 5); // 4 уникальных + 1 дубль
});

test('checkMirror auto: .lst источник → JSON {items}, статистика сохранена', async () => {
  repo.saveRoutingContent('sites', '{\n  "items": []\n}');
  repo.saveRoutingSource('sites', { mode: 'mirror', sourceUrl: 'https://src/list.lst', autoSync: true });
  const before = repo.getRoutingFull('sites')!;
  stubFetch(200, 'youtube.com\n# c\nyoutube.com\ndiscord.com\n');
  const r = await checkMirror('sites', { apply: true });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'ok');
  assert.equal(r.stats?.format, 'lst');
  const after = repo.getRoutingFull('sites')!;
  assert.equal(after.version, before.version + 1);
  assert.equal(after.entryCount, 2); // youtube.com, discord.com (дубль убран)
  assert.deepEqual(JSON.parse(after.content), { items: ['youtube.com', 'discord.com'] });
  assert.equal(after.sourceStats?.format, 'lst');
  assert.equal(after.sourceStats?.dups, 1);
});

test('checkMirror auto: .srs без бинарника → ошибка, версия не растёт', async () => {
  repo.saveRoutingContent('apps', '{\n  "version": 1,\n  "rules": []\n}');
  repo.saveRoutingSource('apps', { mode: 'mirror', sourceUrl: 'https://src/rules.srs', autoSync: true });
  const before = repo.getRoutingFull('apps')!;
  stubFetch(200, 'BINARYSRSBYTES');
  const r = await checkMirror('apps', { apply: true });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'error');
  assert.match(r.reason, /sing-box|SRS/i);
  assert.equal(repo.getRoutingFull('apps')!.version, before.version); // last-known-good
});

test('sourceFormat в мете определяется по URL; смена URL сбрасывает stats', () => {
  repo.saveRoutingSource('sites', { mode: 'mirror', sourceUrl: 'https://src/list.txt', autoSync: false });
  assert.equal(repo.getRoutingFull('sites')!.sourceFormat, 'txt');
  assert.equal(repo.getRoutingFull('sites')!.sourceStats, null); // сброшено сменой URL
});

test('ПУСТОЙ файл + источник-массив: первый синк УСТАНАВЛИВАЕТ тип (не отклоняется)', async () => {
  repo.saveRoutingContent('apps', '{\n  "items": []\n}'); // пустой object-контейнер (count 0)
  repo.saveRoutingSource('apps', { mode: 'mirror', sourceUrl: 'https://src/list.json', autoSync: true });
  const before = repo.getRoutingFull('apps')!;
  stubFetch(200, JSON.stringify(['a.com', 'b.com', 'c.com'])); // массив верхнего уровня ≠ object
  const r = await checkMirror('apps', { apply: true });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'ok'); // раньше было бы 'rejected' («object → array»)
  const after = repo.getRoutingFull('apps')!;
  assert.equal(after.version, before.version + 1);
  assert.equal(after.rootType, 'array');
  assert.equal(after.entryCount, 3);
});

test('convertList: невалидный IPv4 (октет > 255) отбрасывается', () => {
  const c = convertList('999.999.999.999\n10.0.0.1\nok.ru');
  assert.deepEqual(c.items, ['10.0.0.1', 'ok.ru']);
});
