// Одна Xray-конфигурация на пользователя: повторная выдача переиспользует
// существующий активный конфиг, а не плодит новый (работает на любом числе
// устройств одной подпиской).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// БД — во временный файл; ключ шифрования валидной длины (нужен модулю crypto).
const tmp = path.join(os.tmpdir(), `novpn-test-${process.pid}-${Math.floor(process.hrtime()[1])}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.DATABASE_PATH = path.join(tmp, 'database.sqlite');
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.SESSION_SECRET = 'test-secret';

const repo = await import('../src/repo.js');
const { issueForUser } = await import('../src/services/issue.js');
const { buildWhitelistXrayConfig } = await import('@novpn/shared');

let seq = 0;
function seed() {
  seq += 1;
  const server = repo.insertServer({ name: 'FIN', country: 'FI', host: `10.0.0.${seq}`, protocols: ['xray'], endpointOk: true });
  const user = repo.insertUser({
    name: 'Тест', comment: '', category: null, tags: [], code: `code${seq}`,
    deviceLimit: 1, expiresAt: null, trafficLimitGb: null, resetPolicy: 'never',
    allowedServers: [server.id], allowedProtocols: ['xray'],
  });
  const dev = repo.insertDevice({
    userId: user.id, name: 'Телефон', serverId: server.id, protocol: 'xray',
    uuid: 'uuid-1', publicKey: 'pbk-1', link: 'vless://uuid-1@10.0.0.1',
  });
  return { server, user, dev };
}

test('findActiveXrayDevice находит активный конфиг пользователя', () => {
  const { server, user, dev } = seed();
  const found = repo.findActiveXrayDevice(user.id, server.id);
  assert.ok(found, 'должен найтись');
  assert.equal(found!.id, dev.id);
});

test('повторная выдача Xray переиспользует конфиг (reused), не создаёт новый', async () => {
  const { server, user, dev } = seed();
  const before = repo.countActiveDevices(user.id);
  const out = await issueForUser(user, 'Другое устройство', server.id, 'xray', { byAdmin: true });
  assert.equal(out.reused, true, 'должен быть флаг reused');
  assert.equal(out.device.id, dev.id, 'тот же самый конфиг');
  assert.equal(repo.countActiveDevices(user.id), before, 'новых устройств не создалось');
  assert.ok(out.subscriptionUrl === undefined || typeof out.subscriptionUrl === 'string');
});

test('findActiveXrayDevice не возвращает отозванный конфиг', () => {
  const { server, user, dev } = seed();
  repo.updateDeviceFields(dev.id, { is_active: 0 });
  assert.equal(repo.findActiveXrayDevice(user.id, server.id), null);
});

test('subscriptionXrayEntries: serverId у каждой ссылки, порядок новые-первыми', () => {
  seq += 1;
  const s1 = repo.insertServer({ name: 'A', country: null, host: `10.7.1.${seq}`, protocols: ['xray'], endpointOk: true });
  const s2 = repo.insertServer({ name: 'B', country: null, host: `10.7.2.${seq}`, protocols: ['xray'], endpointOk: true });
  const user = repo.insertUser({
    name: 'Е', comment: '', category: null, tags: [], code: `e${seq}`,
    deviceLimit: 1, expiresAt: null, trafficLimitGb: null, resetPolicy: 'never',
    allowedServers: [s1.id, s2.id], allowedProtocols: ['xray'],
  });
  repo.insertDevice({ userId: user.id, name: 'старый', serverId: s1.id, protocol: 'xray', uuid: 'e1', publicKey: 'k1', link: `vless://e1@${s1.host}:443?type=tcp` });
  // Гарантируем разный created_at (ISO-строки с миллисекундами могут совпасть в быстром тесте).
  const past = new Date(Date.now() - 60000).toISOString();
  repo.updateDeviceFields(repo.listDevicesOfUser(user.id)[0]!.id, { created_at: past });
  repo.insertDevice({ userId: user.id, name: 'новый', serverId: s2.id, protocol: 'xray', uuid: 'e2', publicKey: 'k2', link: `vless://e2@${s2.host}:443?type=tcp` });
  const entries = repo.subscriptionXrayEntries(user.id);
  assert.equal(entries.length, 2);
  assert.equal(entries[0]!.serverId, s2.id, 'новый конфиг первым');
  assert.equal(entries[entries.length - 1]!.serverId, s1.id, 'старейший последним (стабильный «основной»)');
});

test('единая подписка: у каждого сервера свой конфиг со СВОЕЙ политикой (массив, без смешивания)', () => {
  seq += 1;
  const wl = repo.insertServer({ name: 'WL', country: null, host: `10.6.1.${seq}`, protocols: ['xray'], endpointOk: true });
  const ft = repo.insertServer({ name: 'FT', country: null, host: `10.6.2.${seq}`, protocols: ['xray'], endpointOk: true });
  // FT — полный туннель (пер-серверный xrayWhitelist=false), WL — обычный обход.
  repo.setEndpointConfig(ft.host, { xrayWhitelist: false });
  const user = repo.insertUser({
    name: 'Ф', comment: '', category: null, tags: [], code: `f${seq}`,
    deviceLimit: 1, expiresAt: null, trafficLimitGb: null, resetPolicy: 'never',
    allowedServers: [wl.id, ft.id], allowedProtocols: ['xray'],
  });
  repo.insertDevice({ userId: user.id, name: 'w', serverId: wl.id, protocol: 'xray', uuid: 'w1', publicKey: 'kw', link: `vless://w1@${wl.host}:443?type=tcp&security=reality&pbk=A&sni=x&sid=1` });
  repo.insertDevice({ userId: user.id, name: 'f', serverId: ft.id, protocol: 'xray', uuid: 'f1', publicKey: 'kf', link: `vless://f1@${ft.host}:443?type=tcp&security=reality&pbk=B&sni=x&sid=2` });
  // Единая подписка = ОДИН элемент на КАЖДЫЙ сервер, каждый со своей политикой:
  // WL с RU-direct правилами (обход), FT без direct-исключений (полный туннель).
  const entries = repo.subscriptionXrayEntries(user.id);
  assert.equal(entries.length, 2, 'оба сервера в единой подписке');
  const cfgOf = (sid: string) => {
    const e = entries.find((x) => x.serverId === sid)!;
    const srv = repo.getServer(sid)!;
    const cfg = repo.getEndpointConfig(srv.host);
    return JSON.parse(buildWhitelistXrayConfig([e.link], 'NoVPN', [], srv.name, cfg.whitelistDomains, cfg.lanAccess, cfg.xrayWhitelist === false));
  };
  const wlCfg = cfgOf(wl.id);
  const ftCfg = cfgOf(ft.id);
  assert.ok(wlCfg.routing.rules.some((r: any) => r.outboundTag === 'direct' && r.domain), 'WL: обход есть');
  assert.ok(!ftCfg.routing.rules.some((r: any) => r.outboundTag === 'direct' && r.domain), 'FT: полный туннель, direct-доменов нет');
  // Пер-серверная полнотуннельная ссылка тоже жива (роут /server/:id/full).
  assert.equal(repo.subscriptionXrayLinks(user.id, ft.id).length, 1);
});

test('пер-серверная подписка: onlyServerId фильтрует ссылки одним сервером', () => {
  seq += 1;
  const s1 = repo.insertServer({ name: 'FIN', country: 'FI', host: `10.9.0.${seq}`, protocols: ['xray'], endpointOk: true });
  const s2 = repo.insertServer({ name: 'HOME', country: null, host: `10.8.0.${seq}`, protocols: ['xray'], endpointOk: true });
  const user = repo.insertUser({
    name: 'Мульти', comment: '', category: null, tags: [], code: `m${seq}`,
    deviceLimit: 1, expiresAt: null, trafficLimitGb: null, resetPolicy: 'never',
    allowedServers: [s1.id, s2.id], allowedProtocols: ['xray'],
  });
  repo.insertDevice({ userId: user.id, name: 'd1', serverId: s1.id, protocol: 'xray', uuid: 'u1', publicKey: 'p1', link: `vless://u1@${s1.host}:443?type=tcp` });
  repo.insertDevice({ userId: user.id, name: 'd2', serverId: s2.id, protocol: 'xray', uuid: 'u2', publicKey: 'p2', link: `vless://u2@${s2.host}:443?type=tcp` });
  // Агрегированная подписка — оба сервера (балансировщик).
  assert.equal(repo.subscriptionXrayLinks(user.id).length, 2);
  // Пер-серверная — строго один сервер, и именно его ссылка.
  const only1 = repo.subscriptionXrayLinks(user.id, s1.id);
  assert.equal(only1.length, 1);
  assert.ok(only1[0]!.includes(s1.host));
  const only2 = repo.subscriptionXrayLinks(user.id, s2.id);
  assert.equal(only2.length, 1);
  assert.ok(only2[0]!.includes(s2.host));
});
