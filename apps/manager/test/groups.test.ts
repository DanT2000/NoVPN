// Панель 1.7.0: группы людей с правилами и «Только приложение NoVPN». Локальная панель на
// тестовой базе, вход тестовым паролем (не боевым).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server as HttpServer } from 'node:http';

const tmp = path.join(os.tmpdir(), `novpn-groups-${process.pid}-${Math.floor(process.hrtime()[1])}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.DATABASE_PATH = path.join(tmp, 'database.sqlite');
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.SESSION_SECRET = 'test-secret';
process.env.ADMIN_PASSWORD = 'test-admin-pass-groups';

const repo = await import('../src/repo.js');
const { createApp } = await import('../src/app.js');
const { APP_ONLY_TITLE } = await import('../src/routes.js');
const { groupDiff, effectiveGroupRules } = await import('@novpn/shared');

let server: HttpServer;
let base = '';
let cookie = '';
let srvA = '';
let srvB = '';
let seq = 810000;

const mkUser = (name: string, category: string, over: Record<string, unknown> = {}) =>
  repo.insertUser({
    name, comment: '', category, tags: [], code: String(seq++),
    deviceLimit: null, expiresAt: null, trafficLimitGb: null, resetPolicy: 'never',
    allowedServers: [srvA, srvB], allowedProtocols: ['xray', 'amneziawg'], allowedProxies: ['http'],
    ...over,
  } as any);

const api = async (method: string, p: string, body?: unknown) => {
  const r = await fetch(`${base}${p}`, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as any };
};

before(async () => {
  srvA = repo.insertServer({ name: 'А', country: null, host: 'a.example.test', protocols: ['xray', 'amneziawg'], endpointOk: true }).id;
  srvB = repo.insertServer({ name: 'Б', country: null, host: 'b.example.test', protocols: ['xray', 'amneziawg'], endpointOk: true }).id;
  await new Promise<void>((resolve) => {
    server = createApp().listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
  const login = await fetch(`${base}/api/admin/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'test-admin-pass-groups' }),
  });
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
  assert.ok(cookie, 'вход админа на тестовой панели');
});

after(() => server?.close());

test('группы: прежние категории людей — группы без правил, с числом участников', () => {
  mkUser('Г1', 'Кружок');
  mkUser('Г2', 'Кружок');
  const g = repo.listGroups().find((x) => x.name === 'Кружок');
  assert.ok(g, 'категория стала группой сама');
  assert.equal(g!.members, 2);
  assert.deepEqual(g!.rules, {}, 'правил нет — у людей ничего не меняется');
});

test('правила группы: мусор отбрасывается, известные поля проверяются', () => {
  const r = repo.normGroupRules({
    allowedServers: ['s1', 's1', 5], allowedProtocols: ['xray', 'ssh'], allowedProxies: ['socks5', 'ftp'],
    priorityAccess: 'да', fullAccess: false, deviceLimit: -1, trafficLimitGb: 50, resetPolicy: 'weekly', evil: 1,
  });
  assert.deepEqual(r, { allowedServers: ['s1'], allowedProtocols: ['xray'], allowedProxies: ['socks5'], fullAccess: false, trafficLimitGb: 50 });
});

test('groupDiff: отличия считаются только по заданным правилам, порядок серверов не важен', () => {
  const u = { allowedServers: ['b', 'a'], allowedProtocols: ['xray' as const], priorityAccess: false, trafficLimitGb: null };
  assert.deepEqual(groupDiff(u, { allowedServers: ['a', 'b'] }), []);
  assert.deepEqual(groupDiff(u, { priorityAccess: true, trafficLimitGb: null }), ['priorityAccess']);
  // «Только NoVPN» само означает «только Xray, без прокси».
  assert.deepEqual(effectiveGroupRules({ appOnly: true }), { appOnly: true, allowedProtocols: ['xray'], allowedProxies: [] });
});

test('«Применить ко всем»: предпросмотр честный, правка снимает лишние конфиги', async () => {
  const a = mkUser('Мама', 'Семья-тест');
  const b = mkUser('Папа', 'Семья-тест', { allowedServers: [srvA] });
  repo.insertDevice({ userId: a.id, name: 'Телефон', serverId: srvB, protocol: 'xray', uuid: 'g-1', publicKey: 'pbk', link: 'vless://g-1@b.example.test:443' });
  repo.insertDevice({ userId: b.id, name: 'Amnezia', serverId: srvA, protocol: 'amneziawg', publicKey: 'awgpub' } as any);

  const created = await api('POST', '/api/admin/groups', { name: 'Семья-тест' });
  assert.equal(created.status, 409, 'категория уже есть — вторую с тем же именем не заводим');

  const rules = { allowedServers: [srvA], allowedProtocols: ['xray'], priorityAccess: true };
  const pv = await api('POST', `/api/admin/groups/${encodeURIComponent('Семья-тест')}/preview`, { rules });
  assert.equal(pv.status, 200);
  const pa = pv.body.people.find((p: any) => p.userId === a.id);
  const pb = pv.body.people.find((p: any) => p.userId === b.id);
  assert.ok(pa.changes.includes('серверы') && pa.revokeConfigs === 1, 'у мамы снимется конфиг сервера Б');
  assert.ok(pb.changes.includes('протоколы') && pb.revokeConfigs === 1, 'у папы снимется Amnezia');
  // Предпросмотр ничего не меняет.
  assert.equal(repo.getUser(a.id)!.priorityAccess, false);

  const ap = await api('POST', `/api/admin/groups/${encodeURIComponent('Семья-тест')}/apply`, { rules });
  assert.equal(ap.status, 200);
  assert.equal(ap.body.changed, 2);
  assert.equal(ap.body.revoked, 2);
  for (const id of [a.id, b.id]) {
    const u = repo.getUser(id)!;
    assert.deepEqual(u.allowedServers, [srvA]);
    assert.deepEqual(u.allowedProtocols, ['xray']);
    assert.equal(u.priorityAccess, true);
    assert.deepEqual(u.allowedProxies, ['http'], 'прокси группа не задаёт — остались личные');
    assert.ok(repo.listDevicesOfUser(id).every((d) => !d.isActive), 'конфиги вне правил сняты');
  }
  assert.deepEqual(repo.getGroup('Семья-тест')!.rules, rules, 'правила сохранены вместе с применением');
  // Повторное применение — уже нечего менять.
  const again = await api('POST', `/api/admin/groups/${encodeURIComponent('Семья-тест')}/apply`, {});
  assert.equal(again.body.changed, 0);
});

test('переименование группы переносит людей; удалить группу с людьми нельзя', async () => {
  mkUser('Р1', 'Старое');
  repo.saveGroupRules('Старое', { priorityAccess: true });
  const r = await api('PUT', `/api/admin/groups/${encodeURIComponent('Старое')}`, { newName: 'Новое' });
  assert.equal(r.status, 200);
  assert.equal(r.body.name, 'Новое');
  assert.equal(r.body.members, 1);
  assert.deepEqual(r.body.rules, { priorityAccess: true });
  assert.equal(repo.getGroup('Старое'), null);
  const del = await api('DELETE', `/api/admin/groups/${encodeURIComponent('Новое')}`);
  assert.equal(del.status, 409);
});

test('«Только приложение NoVPN»: без Amnezia и прокси, чужому приложению — заглушка подписки', async () => {
  const u = mkUser('Валера', 'Церковь-тест');
  repo.insertDevice({ userId: u.id, name: 'ПК', serverId: srvA, protocol: 'xray', uuid: 'v-1', publicKey: 'pbk', link: 'vless://v-1@a.example.test:443' });
  repo.insertDevice({ userId: u.id, name: 'Amnezia', serverId: srvA, protocol: 'amneziawg', publicKey: 'awg2' } as any);
  const r = await api('PATCH', `/api/admin/users/${u.id}`, { appOnly: true, allowedProtocols: ['xray', 'amneziawg'], allowedProxies: ['http'] });
  assert.equal(r.status, 200);
  assert.equal(r.body.appOnly, true);
  assert.deepEqual(r.body.allowedProtocols, ['xray'], 'Amnezia не остаётся даже если прислали');
  assert.deepEqual(r.body.allowedProxies, []);
  const devs = repo.listDevicesOfUser(u.id);
  assert.equal(devs.find((d) => d.protocol === 'amneziawg')!.isActive, false, 'выданная Amnezia снята');
  assert.equal(devs.find((d) => d.protocol === 'xray')!.isActive, true, 'Xray остался');

  const tok = repo.getSubToken(u.id)!;
  // Happ — сообщение вместо серверов.
  const happ = await fetch(`${base}/sub/${tok}`, { headers: { 'user-agent': 'Happ/4.8.0' } });
  const happText = Buffer.from(await happ.text(), 'base64').toString('utf8');
  assert.ok(happText.startsWith('vless://00000000-0000-4000-8000-000000000000@127.0.0.1:1'), 'нерабочий профиль-заглушка');
  assert.ok(decodeURIComponent(happText.split('#')[1]!) === APP_ONLY_TITLE);
  assert.ok(!happText.includes('a.example.test'), 'настоящий сервер чужому приложению не уходит');
  assert.ok(happ.headers.get('announce')?.startsWith('base64:'), 'Happ покажет объявление');
  const full = await fetch(`${base}/sub/${tok}/full`, { headers: { 'user-agent': 'Happ/4.8.0' } });
  const fullText = await full.text();
  assert.equal(JSON.parse(fullText).remarks, APP_ONLY_TITLE);
  assert.ok(!fullText.includes('a.example.test'));
  const perSrv = await fetch(`${base}/sub/${tok}/server/${srvA}/full`, { headers: { 'user-agent': 'v2rayNG/1.10.2' } });
  assert.ok(!(await perSrv.text()).includes('a.example.test'), 'v2rayNG другой версии — тоже чужое');

  // Наше приложение: прежний UA или новый заголовок — настоящая подписка.
  const own = await fetch(`${base}/sub/${tok}`, { headers: { 'user-agent': 'v2rayNG/1.9.5' } });
  assert.ok(Buffer.from(await own.text(), 'base64').toString('utf8').includes('a.example.test'));
  const own2 = await fetch(`${base}/sub/${tok}/full`, { headers: { 'user-agent': 'okhttp/4', 'x-novpn-app': 'android/0.2.15' } });
  assert.ok((await own2.text()).includes('a.example.test'));

  // Кабинет: готовых ссылок для чужих приложений нет, в списке — только наши приложения.
  const pub = repo.buildPublicBootstrap(u.id);
  assert.equal(pub.user?.appOnly, true);
  assert.ok(pub.devices.every((d) => !d.link && !d.conf), 'vless-ссылки и .conf скрыты');
  assert.ok(pub.apps.every((a) => /novpn/i.test(a.client)), 'Happ и прочие не предлагаются');
});

test('без «Только NoVPN» Happ получает подписку как раньше', async () => {
  const u = mkUser('Обычный', 'Общие-тест', { allowedProtocols: ['xray'] });
  repo.insertDevice({ userId: u.id, name: 'ПК', serverId: srvA, protocol: 'xray', uuid: 'o-1', publicKey: 'pbk', link: 'vless://o-1@a.example.test:443' });
  const r = await fetch(`${base}/sub/${repo.getSubToken(u.id)}`, { headers: { 'user-agent': 'Happ/4.8.0' } });
  assert.ok(Buffer.from(await r.text(), 'base64').toString('utf8').includes('a.example.test'));
});

test('создание человека сразу с «Только NoVPN»', async () => {
  const r = await api('POST', '/api/admin/users', {
    name: 'Новенький', category: 'Церковь-тест', allowedServers: [srvA], allowedProtocols: ['xray', 'amneziawg'], allowedProxies: ['socks5'], appOnly: true,
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.appOnly, true);
  assert.deepEqual(r.body.allowedProtocols, ['xray']);
  assert.deepEqual(r.body.allowedProxies, []);
});
