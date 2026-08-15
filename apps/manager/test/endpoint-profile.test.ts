// Endpoint Profile: настраиваемые порты, legacy-алиасы, пер-серверные настройки,
// и главный инвариант — смена порта НЕ ломает выданные конфиги (ссылка патчится на
// текущий host:port, uuid/ключи те же).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = path.join(os.tmpdir(), `novpn-ep-${process.pid}-${Math.floor(process.hrtime()[1])}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.DATABASE_PATH = path.join(tmp, 'database.sqlite');
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.SESSION_SECRET = 'test-secret';

const repo = await import('../src/repo.js');

let seq = 0;
function server(host: string) {
  seq += 1;
  return repo.insertServer({ name: `S${seq}`, country: 'FI', host, protocols: ['xray', 'amneziawg'], endpointOk: true });
}

test('порты по умолчанию = легаси-дефолты (обратная совместимость)', () => {
  const s = server(`d${seq}.example.com`);
  assert.deepEqual(repo.getEndpointPorts(s.host), { xray: 443, awg: 51820, http: 8080, socks: 1080, https: 8443 });
});

test('saveEndpointPorts переопределяет только заданные', () => {
  const s = server(`d${seq}.example.com`);
  repo.saveEndpointPorts(s.host, { xray: 8443, awg: 39221 });
  const p = repo.getEndpointPorts(s.host);
  assert.equal(p.xray, 8443);
  assert.equal(p.awg, 39221);
  assert.equal(p.http, 8080); // не трогали → дефолт
});

test('подписка отдаёт ссылку с ТЕКУЩИМ портом (смена порта без перевыпуска)', () => {
  const host = `d${seq}.example.com`;
  const s = server(host);
  const user = repo.insertUser({
    name: 'U', comment: '', category: null, tags: [], code: `c${seq}`,
    deviceLimit: null, expiresAt: null, trafficLimitGb: null, resetPolicy: 'never',
    allowedServers: [s.id], defaultServerId: s.id, allowedProtocols: ['xray'],
  });
  repo.insertDevice({ userId: user.id, name: 'Phone', serverId: s.id, protocol: 'xray', uuid: 'uuid-x', publicKey: 'pbk', link: `vless://uuid-x@${host}:443?type=tcp#NoVPN-x` });
  // сменили публичный порт Xray
  repo.saveEndpointPorts(host, { xray: 8443 });
  const links = repo.subscriptionXrayLinks(user.id);
  assert.equal(links.length, 1);
  assert.match(links[0]!, new RegExp(`@${host.replace(/\./g, '\\.')}:8443\\?`), 'ссылка должна указывать на новый порт');
  assert.match(links[0]!, /uuid-x/, 'uuid прежний — конфиг не перевыпущен');
});

test('legacy-порты: добавление/чтение/удаление', () => {
  const host = `d${seq}.example.com`;
  server(host);
  repo.addLegacyPort(host, 'xray', 443);
  repo.addLegacyPort(host, 'awg', 51820);
  let ls = repo.getLegacyPorts(host);
  assert.equal(ls.length, 2);
  assert.ok(ls.find((l) => l.proto === 'xray' && l.port === 443));
  const removed = repo.removeLegacyPort(host, 'xray', 443);
  assert.ok(removed && removed.port === 443);
  ls = repo.getLegacyPorts(host);
  assert.equal(ls.length, 1);
  assert.equal(ls[0]!.proto, 'awg');
});

test('пер-серверный конфиг: наследование глобального и переопределение', () => {
  const host = `d${seq}.example.com`;
  server(host);
  // по умолчанию наследует глобальные (xrayWhitelist по умолчанию вкл)
  const inh = repo.getEndpointConfig(host);
  assert.equal(inh.xrayWhitelist, true);
  assert.equal(inh.lanAccess, false);
  assert.equal(inh.fallbackTypes, null);
  // переопределяем на сервере
  repo.setEndpointConfig(host, { lanAccess: true, fallbackTypes: ['http', 'socks'], whitelistDomains: ['domain:ya.ru'] });
  const ov = repo.getEndpointConfig(host);
  assert.equal(ov.lanAccess, true);
  assert.deepEqual(ov.fallbackTypes, ['http', 'socks']);
  assert.deepEqual(ov.whitelistDomains, ['domain:ya.ru']);
  // сброс поля в null → снова наследование
  repo.setEndpointConfig(host, { lanAccess: null });
  assert.equal(repo.getEndpointConfig(host).lanAccess, false);
});

test('detach сохраняет endpoint (ключи/порты/домен), убирает SSH', () => {
  const host = `d${seq}.example.com`;
  const s = server(host);
  repo.saveEndpointPorts(host, { xray: 8443 });
  repo.detachServer(s.id);
  const got = repo.getServer(s.id)!;
  assert.equal(got.detached, true);
  assert.equal(got.ports!.xray, 8443, 'порты endpoint сохранены после detach');
  // профиль по домену на месте
  assert.equal(repo.getEndpointProfile(host).ports.xray, 8443);
});

test('patchAwgConfEndpoint меняет только строку Endpoint', () => {
  const conf = '[Interface]\nPrivateKey = X\n\n[Peer]\nPublicKey = Y\nEndpoint = old.example.com:51820\nAllowedIPs = 0.0.0.0/0';
  const patched = repo.patchAwgConfEndpoint(conf, 'new.example.com', 39221);
  assert.match(patched, /Endpoint = new\.example\.com:39221/);
  assert.match(patched, /PublicKey = Y/);
  assert.doesNotMatch(patched, /51820/);
});
