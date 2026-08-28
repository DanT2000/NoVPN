// Contract-тесты панель↔клиент (docs/NOVPN-CLIENT-CONTRACT.md).
// Поднимаем реальное приложение и дёргаем эндпоинты по HTTP: проверяем не то, что
// функции возвращают внутри, а то, что клиент реально увидит на проводе.
//
// Заодно эти тесты генерируют канонические фикстуры в test/fixtures/contract — их
// использует и клиентская сторона, чтобы обе реализации сверялись с одним и тем же.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server as HttpServer } from 'node:http';

const tmp = path.join(os.tmpdir(), `novpn-contract-${process.pid}-${Math.floor(process.hrtime()[1])}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.DATABASE_PATH = path.join(tmp, 'database.sqlite');
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.SESSION_SECRET = 'test-secret';

const repo = await import('../src/repo.js');
const { seedIfEmpty } = await import('../src/seed.js');
const { createApp } = await import('../src/app.js');
const { CONTRACT_SCHEMA_VERSION } = await import('../src/routes.js');
const autoroute = await import('../src/services/autoroute.js');
const { decodeGeoSite, decodeGeoIp } = await import('../src/lib/geodat.js');

seedIfEmpty();

const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'contract');
fs.mkdirSync(FIXTURES, { recursive: true });

let server: HttpServer;
let base = '';
let subToken = '';
let bothHost = '';
let fullHost = '';
let bothId = '';
let fullId = '';
let userId = '';

before(async () => {
  // Сборка AutoRoute: один источник «в VPN» — домены и подсеть.
  for (const s of repo.listAutoRouteSources()) repo.deleteAutoRouteSource(s.id);
  const src = repo.addAutoRouteSource({ title: 'Тестовый список', url: 'https://src/list.lst', action: 'vpn' });
  // Стаб только на время скачивания источника: дальше тесты ходят в поднятое
  // приложение настоящим fetch'ем.
  const realFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => new Response('blocked.example\nfull:exact.example\n10.10.0.0/16\n', { status: 200 });
  try {
    await autoroute.refreshSource(src.id);
  } finally {
    globalThis.fetch = realFetch;
  }
  autoroute.buildDataset();

  const both = repo.insertServer({ name: 'Франция', country: '🇫🇷 Франция', host: 'fr.example.test', protocols: ['xray'], endpointOk: true });
  const full = repo.insertServer({ name: 'Дом', country: '🇷🇺 Россия', host: 'home.example.test', protocols: ['xray'], endpointOk: true });
  bothHost = both.host;
  fullHost = full.host;
  bothId = both.id;
  fullId = full.id;
  // Первый сервер выдаёт оба профиля (+ 3 своих домена), второй — только полный.
  repo.setEndpointConfig(both.host, { profiles: 'both', whitelistDomains: ['x.ru', 'y.ru', 'z.ru'] });
  repo.setEndpointConfig(full.host, { profiles: 'full', whitelistDomains: ['a.ru', 'b.ru'] });
  const user = repo.insertUser({
    name: 'Контракт', comment: '', category: null, tags: [], code: 'code01',
    deviceLimit: 5, expiresAt: null, trafficLimitGb: null, resetPolicy: 'never',
    allowedServers: [both.id, full.id], allowedProtocols: ['xray'],
  });
  userId = user.id;
  repo.insertDevice({ userId: user.id, name: 'ПК', serverId: both.id, protocol: 'xray', uuid: 'u-1', publicKey: 'pbk', link: `vless://u-1@${both.host}:443` });
  repo.insertDevice({ userId: user.id, name: 'Ноут', serverId: full.id, protocol: 'xray', uuid: 'u-2', publicKey: 'pbk', link: `vless://u-2@${full.host}:443` });
  subToken = repo.getSubToken(user.id)!;

  await new Promise<void>((resolve) => {
    server = createApp().listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
});

after(() => {
  server?.close();
});

const getJson = async (p: string, headers: Record<string, string> = {}) => {
  const r = await fetch(`${base}${p}`, { headers });
  return { status: r.status, headers: r.headers, body: r.status === 304 ? null : await r.json() };
};
// Фикстуры лежат в git: всё случайное (порт тест-сервера, id серверов, токен подписки,
// метки времени) заменяем на стабильные значения, иначе каждый прогон — новый diff.
// Замена сквозная по файлу, поэтому связи (профиль ↔ ссылка ↔ meta.json) сохраняются.
const stableFixture = (json: string): string => {
  const ids = new Map<string, string>();
  return json
    .replace(/http:\/\/127\.0\.0\.1:\d+/g, 'https://panel.example')
    .replace(/\/sub\/[A-Za-z0-9_-]{16,}\//g, '/sub/FIXTURE-TOKEN/')
    // id сервера (s_ + 8 символов nanoid) встречается и голым, и в profileId «s_x:full», и в URL.
    .replace(/(?<![A-Za-z0-9_-])s_(?!legacy(?![A-Za-z0-9_-])|fixture)[A-Za-z0-9_-]{8}(?![A-Za-z0-9_-])/g, (m) => {
      if (!ids.has(m)) ids.set(m, `s_fixture${ids.size + 1}`);
      return ids.get(m)!;
    })
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '2026-08-28T00:00:00.000Z');
};
const saveFixture = (name: string, value: unknown) => {
  let v: any = value;
  if (v && Array.isArray(v.profiles)) {
    // Порядок профилей — не часть контракта (клиент сопоставляет по profileId); в файле
    // фиксируем канонический (host, smart→full), иначе случайные id серверов тасуют массив.
    const profiles = [...v.profiles].sort(
      (a: any, b: any) =>
        String(a.host).localeCompare(String(b.host)) ||
        (a.routing?.mode === 'full' ? 1 : 0) - (b.routing?.mode === 'full' ? 1 : 0),
    );
    v = { ...v, profiles };
  }
  fs.writeFileSync(path.join(FIXTURES, `${name}.json`), stableFixture(JSON.stringify(v, null, 2)) + '\n');
};

// ── meta.json ────────────────────────────────────────────────────────────────

test('meta.json: конверт соответствует схеме контракта', async () => {
  const { status, body } = await getJson(`/sub/${subToken}/meta.json`);
  assert.equal(status, 200);
  assert.equal(body.schemaVersion, CONTRACT_SCHEMA_VERSION);
  assert.equal(typeof body.panel?.name, 'string');
  assert.ok(/^https?:\/\//.test(body.panel?.origin ?? ''), 'origin — абсолютный URL');
  for (const k of ['manifest', 'upstream', 'apps']) {
    assert.ok(/^https?:\/\/.+\.json$/.test(body.routingResources?.[k] ?? ''), `routingResources.${k} — абсолютный URL`);
  }
  for (const k of ['geosite', 'geoip']) {
    assert.ok(/^https?:\/\/.+\.dat$/.test(body.routingResources?.[k] ?? ''), `routingResources.${k} — ссылка на .dat`);
  }
  assert.equal(body.routingResources.sites, undefined, 'sites убран из контракта');
  assert.ok(Array.isArray(body.profiles), 'profiles[] вместо servers[]');
  saveFixture('smart-and-full', body);
});

test('meta.json: профили — умный первым (recommended), полный вторым; полный-only сервер даёт один', async () => {
  const { body } = await getJson(`/sub/${subToken}/meta.json`);
  const ids = body.profiles.map((p: any) => p.profileId);
  assert.deepEqual([...ids].sort(), [bothId, `${bothId}:full`, `${fullId}:full`].sort(), 'набор профилей: умный + полный у «обоих» сервера, один полный у full-only');
  // Внутри сервера порядок строгий: умный сразу перед своим полным.
  assert.equal(ids.indexOf(`${bothId}:full`), ids.indexOf(bothId) + 1, 'полный профиль идёт сразу за умным того же сервера');
  const smart = body.profiles.find((p: any) => p.profileId === bothId);
  const full = body.profiles.find((p: any) => p.profileId === `${bothId}:full`);
  assert.equal(smart.routing.mode, 'smart');
  assert.equal(smart.recommended, true);
  assert.equal(smart.routing.ownExceptions, 3);
  assert.equal(full.routing.mode, 'full');
  assert.equal(full.recommended, false);
  assert.equal(full.routing.ownExceptions, 0, 'в full доменные правила не применяются');
  assert.equal(full.host, smart.host, 'два профиля одного сервера делят host — поэтому ключ profileId');
  assert.equal(full.remark, `${smart.remark} · Полный VPN`);
  assert.ok(full.subLink.endsWith('?profile=full'));
  saveFixture('smart-only', { ...body, profiles: [smart] });
  saveFixture('full-only', { ...body, profiles: [body.profiles.find((p: any) => p.profileId === `${fullId}:full`)] });
});

test('meta.json: у каждого профиля обязательные поля и допустимый mode', async () => {
  const { body } = await getJson(`/sub/${subToken}/meta.json`);
  for (const p of body.profiles) {
    assert.equal(typeof p.profileId, 'string');
    assert.equal(typeof p.serverId, 'string');
    assert.equal(typeof p.host, 'string');
    assert.equal(typeof p.remark, 'string');
    assert.equal(typeof p.recommended, 'boolean');
    assert.ok(Array.isArray(p.protocols));
    assert.equal(typeof p.online, 'boolean');
    assert.ok(['smart', 'full'].includes(p.routing.mode), `недопустимый mode: ${p.routing.mode}`);
    assert.equal(typeof p.routing.lanAccess, 'boolean');
    assert.ok(p.routing.fallbackTypes === null || Array.isArray(p.routing.fallbackTypes));
    assert.equal(typeof p.routing.ownExceptions, 'number');
  }
});

test('подписка /full: один конфиг на профиль, 1:1 с meta.profiles, meta.novpn.profileId в каждом', async () => {
  const { body } = await getJson(`/sub/${subToken}/meta.json`);
  const sub = await (await fetch(`${base}/sub/${subToken}/full`)).text();
  const parsed = JSON.parse(sub) as unknown;
  const configs = (Array.isArray(parsed) ? parsed : [parsed]) as Array<any>;
  assert.equal(configs.length, body.profiles.length, 'конфигов ровно столько же, сколько профилей');
  configs.forEach((cfg, i) => {
    const p = body.profiles[i];
    assert.equal(cfg.meta.novpn.profileId, p.profileId, `порядок и profileId совпадают (#${i})`);
    assert.equal(cfg.meta.novpn.mode, p.routing.mode);
    assert.equal(cfg.meta.novpn.host, p.host);
    assert.equal(cfg.remarks, p.remark, 'remarks конфига = remark профиля');
    const addr = cfg.outbounds.find((o: any) => o.protocol === 'vless').settings.vnext[0].address;
    assert.equal(addr, p.host, 'host из meta — это адрес vless-исходящего');
  });
});

test('подписка: умный профиль = список AutoRoute + свои домены → VPN, остальное direct; полный = всё в VPN, fail-close', async () => {
  const sub = JSON.parse(await (await fetch(`${base}/sub/${subToken}/full`)).text()) as any[];
  const smart = sub.find((c) => c.meta.novpn.profileId === bothId);
  const full = sub.find((c) => c.meta.novpn.profileId === `${bothId}:full`);
  assert.ok(smart && full, 'оба профиля сервера присутствуют в подписке');
  // умный: доменное правило ведёт в прокси, терминальное — direct
  const listRule = smart.routing.rules.find((r: any) => r.domain);
  assert.ok(listRule, 'доменное правило есть');
  assert.equal(listRule.outboundTag, 'proxy-t0-0', 'список идёт В VPN (match-vpn)');
  assert.ok(listRule.domain.includes('domain:blocked.example'), 'домен из AutoRoute');
  assert.ok(listRule.domain.includes('full:exact.example'), 'вид full сохранён');
  assert.ok(listRule.domain.includes('domain:x.ru'), 'свой домен сервера дополняет список');
  const ipRule = smart.routing.rules.find((r: any) => r.ip && !r.ip.includes('127.0.0.0/8'));
  assert.ok(ipRule && ipRule.ip.includes('10.10.0.0/16'), 'CIDR из AutoRoute — тоже в VPN');
  const last = smart.routing.rules[smart.routing.rules.length - 1];
  assert.equal(last.outboundTag, 'direct', 'всё остальное — напрямую');
  // полный: ни одного доменного правила, терминальное — в прокси
  assert.ok(!full.routing.rules.some((r: any) => r.domain), 'в полном нет доменных правил');
  const lastFull = full.routing.rules[full.routing.rules.length - 1];
  assert.equal(lastFull.outboundTag, 'proxy-t0-0');
  // QUIC-блок в обоих
  for (const cfg of [smart, full]) assert.ok(cfg.routing.rules.some((r: any) => r.network === 'udp' && r.port === 443 && r.outboundTag === 'block'));
});

test('умная маршрутизация выключена на сервере → только полный профиль; включена → оба у любого пользователя', async () => {
  repo.setEndpointConfig(bothHost, { profiles: 'full' });
  let { body } = await getJson(`/sub/${subToken}/meta.json`);
  assert.deepEqual(body.profiles.map((p: any) => p.profileId).sort(), [`${bothId}:full`, `${fullId}:full`].sort(), 'умный профиль пропал у сервера с выключенной умной');
  let sub = JSON.parse(await (await fetch(`${base}/sub/${subToken}/full`)).text()) as any[];
  assert.equal(sub.length, 2);
  // ?profile=full и без него — один и тот же полный профиль
  const one = JSON.parse(await (await fetch(`${base}/sub/${subToken}/server/${bothId}/full`)).text());
  assert.equal(one.meta.novpn.mode, 'full');
  // включили обратно — оба профиля, без каких-либо пер-пользовательских разрешений
  repo.setEndpointConfig(bothHost, { profiles: 'both' });
  ({ body } = await getJson(`/sub/${subToken}/meta.json`));
  assert.deepEqual(body.profiles.map((p: any) => p.profileId).sort(), [bothId, `${bothId}:full`, `${fullId}:full`].sort());
  const back = JSON.parse(await (await fetch(`${base}/sub/${subToken}/server/${bothId}/full?profile=full`)).text());
  assert.equal(back.meta.novpn.mode, 'full');
});

test('meta.json: чужой/битый токен — 404, а не пустой ответ', async () => {
  const r = await getJson('/sub/nope-not-a-token/meta.json');
  assert.equal(r.status, 404);
  assert.equal(r.body.error.type, 'not_found');
});

// Отзыв доступа обязан отличаться от «панель не ответила»: клиент по сетевой ошибке
// кэш не стирает, поэтому без явного авторитетного ответа отключённый пользователь
// продолжал бы подключаться по last-known-good бесконечно.
test('meta.json: отзыв доступа — 403 с машинно-читаемой причиной, не 404 и не 200', async () => {
  const victim = repo.insertUser({
    name: 'Отозванный', comment: '', category: null, tags: [], code: 'code02',
    deviceLimit: 1, expiresAt: null, trafficLimitGb: null, resetPolicy: 'never',
    allowedServers: [], allowedProtocols: ['xray'],
  });
  const t = repo.getSubToken(victim.id)!;
  assert.equal((await getJson(`/sub/${t}/meta.json`)).status, 200, 'пока доступ есть — 200');

  repo.updateUserFields(victim.id, { is_active: 0 });
  let r = await getJson(`/sub/${t}/meta.json`);
  assert.equal(r.status, 403);
  assert.equal(r.body.error.type, 'disabled');

  repo.updateUserFields(victim.id, { is_active: 1, expires_at: new Date(Date.now() - 86_400_000).toISOString() });
  r = await getJson(`/sub/${t}/meta.json`);
  assert.equal(r.status, 403);
  assert.equal(r.body.error.type, 'expired');

  repo.updateUserFields(victim.id, { expires_at: null, traffic_limit_gb: 1, traffic_used_gb: 2 });
  r = await getJson(`/sub/${t}/meta.json`);
  assert.equal(r.status, 403);
  assert.equal(r.body.error.type, 'traffic');
});

test('legacy-фикстура без блока routing обязана читаться как smart', () => {
  const legacy = {
    schemaVersion: 1,
    panel: { name: 'NoVPN', origin: 'https://old.example' },
    routingResources: {
      manifest: 'https://old.example/routing/manifest.json',
      upstream: 'https://old.example/routing/upstream.json',
      apps: 'https://old.example/routing/apps.json',
    },
    profiles: [{ profileId: 's_legacy', serverId: 's_legacy', host: 'legacy.example', remark: 'Старый', protocols: ['xray'], online: true }],
  };
  const p = legacy.profiles[0] as { routing?: { mode?: string } };
  assert.equal(p.routing?.mode ?? 'smart', 'smart', 'нет routing → smart');
  saveFixture('legacy-no-routing', legacy);
  saveFixture('expired-full', {
    ...legacy,
    profiles: [{ ...legacy.profiles[0], profileId: 's_legacy:full', routing: { mode: 'full', lanAccess: false, fallbackTypes: null, ownExceptions: 0, expiresAt: '2020-01-01T00:00:00.000Z' } }],
  });
  saveFixture('invalid-routing-version', { ...legacy, schemaVersion: 999 });
});

// ── списки, DAT, manifest.json и условный GET ────────────────────────────────

test('upstream.json: грамматика items — домены, full:/keyword:/regexp:, голые CIDR', async () => {
  const { body } = await getJson('/routing/upstream.json');
  assert.ok(Array.isArray(body.items));
  assert.ok(body.items.includes('blocked.example'), 'голый домен');
  assert.ok(body.items.includes('full:exact.example'), 'точное совпадение с префиксом');
  assert.ok(body.items.includes('10.10.0.0/16'), 'CIDR голым, без префикса');
  saveFixture('upstream', body);
});

test('geosite.dat / geoip.dat: настоящий V2Ray-формат, тег NOVPN, тот же набор, что в upstream.json', async () => {
  const gs = Buffer.from(await (await fetch(`${base}/routing/autoroute/geosite.dat`)).arrayBuffer());
  const gi = Buffer.from(await (await fetch(`${base}/routing/autoroute/geoip.dat`)).arrayBuffer());
  const sites = decodeGeoSite(gs);
  assert.equal(sites.length, 1);
  assert.equal(sites[0]!.tag, 'NOVPN');
  const values = sites[0]!.domains.map((d) => d.value).sort();
  assert.deepEqual(values, ['blocked.example', 'exact.example', 'x.ru', 'y.ru', 'z.ru'].filter((v) => !/^[xyz]\.ru$/.test(v)).sort(), 'в DAT — датасет AutoRoute (свои домены серверов туда не входят)');
  assert.equal(sites[0]!.domains.find((d) => d.value === 'exact.example')!.type, 3, 'full → Type.Full=3');
  assert.equal(sites[0]!.domains.find((d) => d.value === 'blocked.example')!.type, 2, 'domain → Type.Domain=2');
  const ips = decodeGeoIp(gi);
  assert.equal(ips[0]!.tag, 'NOVPN');
  assert.equal(ips[0]!.cidrs.length, 1);
  assert.deepEqual([...ips[0]!.cidrs[0]!.ip], [10, 10, 0, 0]);
  assert.equal(ips[0]!.cidrs[0]!.prefix, 16);
});

test('manifest.json: перечисляет json и dat, sha256 совпадает с реальным содержимым', async () => {
  const { status, body } = await getJson('/routing/manifest.json');
  assert.equal(status, 200);
  assert.equal(body.schemaVersion, CONTRACT_SCHEMA_VERSION);
  const names = body.files.map((f: any) => f.name).sort();
  assert.deepEqual(names, ['apps', 'geoip', 'geosite', 'upstream']);
  for (const f of body.files) {
    const raw = Buffer.from(await (await fetch(f.url.replace(/^https?:\/\/[^/]+/, base))).arrayBuffer());
    assert.equal(crypto.createHash('sha256').update(raw).digest('hex'), f.sha256, `sha256 не сходится: ${f.name}`);
    assert.equal(raw.length, f.bytes);
    assert.ok(Number.isInteger(f.version) && f.version >= 0);
  }
  saveFixture('routing-manifest', body);
});

test('routing: условный GET отдаёт 304 и не гоняет список заново (json и dat)', async () => {
  for (const p of ['/routing/upstream.json', '/routing/autoroute/geosite.dat']) {
    const first = await fetch(`${base}${p}`);
    assert.equal(first.status, 200);
    const etag = first.headers.get('etag');
    assert.ok(etag && etag.startsWith('"'), `сильный ETag: ${p}`);
    const second = await fetch(`${base}${p}`, { headers: { 'If-None-Match': etag! } });
    assert.equal(second.status, 304, `304: ${p}`);
    assert.equal((await second.text()).length, 0, '304 без тела');
  }
  const stale = await fetch(`${base}/routing/upstream.json`, { headers: { 'If-None-Match': '"some-other-etag"' } });
  assert.equal(stale.status, 200, 'чужой ETag → полный ответ');
});

test('routing: sites.json убран — 404; неизвестный файл — 404', async () => {
  assert.equal((await getJson('/routing/sites.json')).status, 404);
  assert.equal((await getJson('/routing/secrets.json')).status, 404);
  assert.equal((await getJson('/routing/autoroute/other.dat')).status, 404);
});
