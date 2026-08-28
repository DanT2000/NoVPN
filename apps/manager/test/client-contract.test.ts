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

seedIfEmpty();

const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'contract');
fs.mkdirSync(FIXTURES, { recursive: true });

let server: HttpServer;
let base = '';
let subToken = '';
let smartHost = '';
let fullHost = '';

before(async () => {
  const smart = repo.insertServer({ name: 'Франция', country: '🇫🇷 Франция', host: 'fr.example.test', protocols: ['xray'], endpointOk: true });
  const full = repo.insertServer({ name: 'Дом', country: '🇷🇺 Россия', host: 'home.example.test', protocols: ['xray'], endpointOk: true });
  smartHost = smart.host;
  fullHost = full.host;
  repo.setServerFields?.(smart.id, {});
  const user = repo.insertUser({
    name: 'Контракт', comment: '', category: null, tags: [], code: 'code01',
    deviceLimit: 5, expiresAt: null, trafficLimitGb: null, resetPolicy: 'never',
    allowedServers: [smart.id, full.id], allowedProtocols: ['xray'],
  });
  repo.insertDevice({ userId: user.id, name: 'ПК', serverId: smart.id, protocol: 'xray', uuid: 'u-1', publicKey: 'pbk', link: `vless://u-1@${smart.host}:443` });
  repo.insertDevice({ userId: user.id, name: 'Ноут', serverId: full.id, protocol: 'xray', uuid: 'u-2', publicKey: 'pbk', link: `vless://u-2@${full.host}:443` });
  // Второй сервер — «Полный VPN» + свои исключения (они в full применяться НЕ должны).
  repo.setEndpointConfig(full.host, { xrayWhitelist: false, whitelistDomains: ['a.ru', 'b.ru'] });
  repo.setEndpointConfig(smart.host, { whitelistDomains: ['x.ru', 'y.ru', 'z.ru'] });
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
const saveFixture = (name: string, value: unknown) =>
  fs.writeFileSync(path.join(FIXTURES, `${name}.json`), JSON.stringify(value, null, 2) + '\n');

// ── meta.json ────────────────────────────────────────────────────────────────

test('meta.json: конверт соответствует схеме контракта', async () => {
  const { status, body } = await getJson(`/sub/${subToken}/meta.json`);
  assert.equal(status, 200);
  assert.equal(body.schemaVersion, CONTRACT_SCHEMA_VERSION);
  assert.equal(typeof body.panel?.name, 'string');
  assert.ok(/^https?:\/\//.test(body.panel?.origin ?? ''), 'origin — абсолютный URL');
  for (const k of ['manifest', 'upstream', 'sites', 'apps']) {
    assert.ok(/^https?:\/\/.+\.json$/.test(body.routingResources?.[k] ?? ''), `routingResources.${k} — абсолютный URL`);
  }
  assert.ok(Array.isArray(body.servers) && body.servers.length === 2);
  saveFixture('smart-and-full', body);
});

test('meta.json: у каждого сервера обязательные поля и допустимый mode', async () => {
  const { body } = await getJson(`/sub/${subToken}/meta.json`);
  for (const s of body.servers) {
    assert.equal(typeof s.id, 'string');
    assert.equal(typeof s.host, 'string');
    assert.equal(typeof s.remark, 'string');
    assert.ok(Array.isArray(s.protocols));
    assert.equal(typeof s.online, 'boolean');
    assert.ok(['smart', 'full'].includes(s.routing.mode), `недопустимый mode: ${s.routing.mode}`);
    assert.equal(typeof s.routing.lanAccess, 'boolean');
    assert.ok(s.routing.fallbackTypes === null || Array.isArray(s.routing.fallbackTypes));
    assert.equal(typeof s.routing.ownExceptions, 'number');
  }
});

test('meta.json: mode берётся из настройки сервера, в full исключения обнуляются', async () => {
  const { body } = await getJson(`/sub/${subToken}/meta.json`);
  const smart = body.servers.find((s: any) => s.host === smartHost);
  const full = body.servers.find((s: any) => s.host === fullHost);
  assert.equal(smart.routing.mode, 'smart');
  assert.equal(smart.routing.ownExceptions, 3, 'у smart считаем свои домены');
  assert.equal(full.routing.mode, 'full');
  assert.equal(full.routing.ownExceptions, 0, 'в full доменные исключения не применяются — счётчик 0');
  saveFixture('smart-only', { ...body, servers: [smart] });
  saveFixture('full-only', { ...body, servers: [full] });
});

test('meta.json: host совпадает с адресом в ссылке подписки — по нему клиент и матчит', async () => {
  const { body } = await getJson(`/sub/${subToken}/meta.json`);
  // Подписка — это Xray-конфиг (или массив конфигов), а не список vless-ссылок:
  // адрес сервера лежит в outbounds[].settings.vnext[].address. Именно его клиент
  // и сопоставляет с meta.servers[].host.
  const sub = await (await fetch(`${base}/sub/${subToken}/full`)).text();
  const parsed = JSON.parse(sub) as unknown;
  const configs = (Array.isArray(parsed) ? parsed : [parsed]) as Array<{ outbounds?: Array<{ settings?: { vnext?: Array<{ address?: string }> } }> }>;
  const addresses = new Set<string>();
  for (const cfg of configs) {
    for (const o of cfg.outbounds ?? []) {
      for (const v of o.settings?.vnext ?? []) if (v.address) addresses.add(String(v.address));
    }
  }
  for (const s of body.servers) {
    assert.ok(addresses.has(s.host), `в подписке нет исходящего на ${s.host}; есть: ${[...addresses].join(', ')}`);
  }
});

test('meta.json: remark = значок + имя сервера, как в панели', async () => {
  const { body } = await getJson(`/sub/${subToken}/meta.json`);
  const smart = body.servers.find((s: any) => s.host === smartHost);
  assert.equal(smart.remark, '🇫🇷 Франция');
});

test('meta.json: чужой/битый токен — 404, а не пустой ответ', async () => {
  assert.equal((await getJson('/sub/nope-not-a-token/meta.json')).status, 404);
});

test('legacy-фикстура без блока routing обязана читаться как smart', () => {
  // Клиент должен принимать ответ старой панели. Фиксируем эталон в фикстурах.
  const legacy = {
    schemaVersion: 1,
    panel: { name: 'NoVPN', origin: 'https://old.example' },
    routingResources: {
      manifest: 'https://old.example/routing/manifest.json',
      upstream: 'https://old.example/routing/upstream.json',
      sites: 'https://old.example/routing/sites.json',
      apps: 'https://old.example/routing/apps.json',
    },
    servers: [{ id: 's_legacy', host: 'legacy.example', remark: 'Старый', protocols: ['xray'], online: true }],
  };
  const s = legacy.servers[0] as { routing?: { mode?: string } };
  assert.equal(s.routing?.mode ?? 'smart', 'smart', 'нет routing → smart');
  saveFixture('legacy-no-routing', legacy);
  saveFixture('expired-full', {
    ...legacy,
    servers: [{ ...legacy.servers[0], routing: { mode: 'full', lanAccess: false, fallbackTypes: null, ownExceptions: 0, expiresAt: '2020-01-01T00:00:00.000Z' } }],
  });
  saveFixture('invalid-routing-version', { ...legacy, schemaVersion: 999 });
});

// ── manifest.json и условный GET ─────────────────────────────────────────────

test('manifest.json: перечисляет файлы, sha256 совпадает с реальным содержимым', async () => {
  const { status, body } = await getJson('/routing/manifest.json');
  assert.equal(status, 200);
  assert.equal(body.schemaVersion, CONTRACT_SCHEMA_VERSION);
  const names = body.files.map((f: any) => f.name).sort();
  assert.deepEqual(names, ['apps', 'sites', 'upstream']);
  for (const f of body.files) {
    const raw = await (await fetch(f.url.replace(/^https?:\/\/[^/]+/, base))).text();
    assert.equal(crypto.createHash('sha256').update(raw, 'utf8').digest('hex'), f.sha256, `sha256 не сходится: ${f.name}`);
    assert.equal(Buffer.byteLength(raw, 'utf8'), f.bytes);
    assert.ok(Number.isInteger(f.version) && f.version >= 1);
  }
  saveFixture('routing-manifest', body);
});

test('routing: условный GET отдаёт 304 и не гоняет список заново', async () => {
  const first = await fetch(`${base}/routing/upstream.json`);
  assert.equal(first.status, 200);
  const etag = first.headers.get('etag');
  assert.ok(etag && etag.startsWith('"'), 'сильный ETag по содержимому');
  assert.ok(first.headers.get('last-modified'), 'Last-Modified тоже отдаётся');

  const second = await fetch(`${base}/routing/upstream.json`, { headers: { 'If-None-Match': etag! } });
  assert.equal(second.status, 304);
  assert.equal((await second.text()).length, 0, '304 без тела');

  const stale = await fetch(`${base}/routing/upstream.json`, { headers: { 'If-None-Match': '"some-other-etag"' } });
  assert.equal(stale.status, 200, 'чужой ETag → полный ответ');
});

test('routing: правка содержимого меняет ETag — клиент увидит обновление', async () => {
  const before = (await fetch(`${base}/routing/sites.json`)).headers.get('etag');
  repo.saveRoutingContent('sites', JSON.stringify({ items: ['changed.example'] }, null, 2));
  const after = (await fetch(`${base}/routing/sites.json`)).headers.get('etag');
  assert.notEqual(before, after, 'ETag обязан измениться вместе с содержимым');
});

test('routing: неизвестный файл — 404 (список файлов закрыт)', async () => {
  assert.equal((await getJson('/routing/secrets.json')).status, 404);
});
