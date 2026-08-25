// Регрессии #4/#5 аудита:
//  #4 все аксессоры server_keys нормализуют host через domainKey — один сервер = одна
//     строка (регистр/порт/схема в host не расщепляют ключи и порты по разным строкам);
//  #5 при restore без персистнутых портов порт берётся из выданного конфига, не DEFAULT.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = path.join(os.tmpdir(), `novpn-epnorm-${process.pid}-${Math.floor(process.hrtime()[1])}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.DATABASE_PATH = path.join(tmp, 'database.sqlite');
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.SESSION_SECRET = 'test-secret';

const repo = await import('../src/repo.js');
const { domainKey } = await import('../src/lib/domain.js');
const kv = await import('../src/services/keyvault.js');

test('domainKey: регистр/схема/порт/путь → канонический домен', () => {
  assert.equal(domainKey('Vpn.Example.COM'), 'vpn.example.com');
  assert.equal(domainKey('https://vpn.example.com:443/x'), 'vpn.example.com');
  assert.equal(domainKey('  vpn.example.com:51820 '), 'vpn.example.com');
  assert.equal(domainKey('1.2.3.4'), '1.2.3.4');
});

test('#4 порты и ключи одного сервера при неканоничном host — ОДНА строка server_keys', () => {
  // ключи пишем по «сырому» варианту, порты — по другому написанию того же домена
  kv.saveServerKeys('MyVPN.Example.com', { awgServerPubKey: 'pub-A', awgServerPrivKey: 'priv-A' });
  repo.saveEndpointPorts('myvpn.example.com:51820', { xray: 8443, awg: 40000 });
  repo.setEndpointConfig('https://myvpn.example.com/', { lanAccess: true });
  // читаем третьим написанием — всё должно сойтись в одной строке
  const prof = repo.getEndpointProfile('  MYVPN.example.COM ');
  assert.equal(prof.exists, true);
  assert.equal(prof.hasAwgKeys, true, 'ключи видны');
  assert.equal(prof.ports.awg, 40000, 'порты видны той же строке');
  assert.equal(prof.ports.xray, 8443);
  assert.equal(repo.getEndpointConfig('myvpn.example.com').lanAccess, true);
  assert.equal(kv.getServerKeys('myvpn.example.com')?.awgServerPubKey, 'pub-A');
});

test('#5 awgPortFromDevice / xrayPortFromDevice: порт из выданного конфига; getSavedEndpointPorts null без персиста', () => {
  const srv = repo.insertServer({ name: 'OLD', country: null, host: 'old.example.com', protocols: ['xray', 'amneziawg'], endpointOk: true });
  const u = repo.insertUser({ name: 'U', comment: '', category: null, tags: [], code: 'ep1', deviceLimit: null, expiresAt: null, trafficLimitGb: null, resetPolicy: 'never', allowedServers: [srv.id], allowedProtocols: ['xray', 'amneziawg'] });
  // порты НЕ сохранялись → явных нет, getEndpointPorts отдаёт дефолты
  assert.deepEqual(repo.getSavedEndpointPorts('old.example.com'), { xray: null, awg: null });
  assert.equal(repo.getEndpointPorts('old.example.com').awg, 51820);
  const conf = ['[Interface]', 'PrivateKey = k', 'Address = 10.8.1.5/32', 'Jc = 4', '[Peer]', 'PublicKey = p', 'Endpoint = old.example.com:30122', 'AllowedIPs = 0.0.0.0/0'].join('\n');
  repo.insertDevice({ userId: u.id, name: 'awg', serverId: srv.id, protocol: 'amneziawg', publicKey: 'cp', clientIp: '10.8.1.5/32', conf });
  repo.insertDevice({ userId: u.id, name: 'xr', serverId: srv.id, protocol: 'xray', uuid: 'uu', publicKey: 'pk', link: 'vless://uu@old.example.com:30121?security=reality#x' });
  assert.equal(repo.awgPortFromDevice(srv.id), 30122, 'порт AWG из Endpoint выданного конфига');
  assert.equal(repo.xrayPortFromDevice(srv.id), 30121, 'порт Xray из выданной ссылки');
  // после персиста — явные порты видны
  repo.saveEndpointPorts('old.example.com', { awg: 30122, xray: 30121 });
  assert.deepEqual(repo.getSavedEndpointPorts('old.example.com'), { xray: 30121, awg: 30122 });
});
