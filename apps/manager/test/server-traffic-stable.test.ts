// Регрессия: итог трафика сервера (servers.traffic_gb) считается из ПЕРСИСТЕНТНЫХ
// счётчиков всех устройств/прокси сервера, а НЕ из «увиденных за один цикл синка».
// Иначе неполный замер (холодный SSH после рестарта панели) схлопывал итог до нуля,
// а следующий цикл возвращал — и график Dashboard показывал фантомные сотни ГБ «за час».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = path.join(os.tmpdir(), `novpn-srvtraf-${process.pid}-${Math.floor(process.hrtime()[1])}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.DATABASE_PATH = path.join(tmp, 'database.sqlite');
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.SESSION_SECRET = 'test-secret';

const repo = await import('../src/repo.js');
const { encryptSecret } = await import('../src/lib/crypto.js');

const GB = 1e9;

test('serverTrafficGb = сумма накопленного по устройствам + прокси сервера', () => {
  const server = repo.insertServer({ name: 'FIN', country: 'FI', host: '10.9.0.1', protocols: ['xray', 'amneziawg'], endpointOk: true });
  const user = repo.insertUser({ name: 'U', comment: '', category: null, tags: [], code: 'st1', deviceLimit: null, expiresAt: null, trafficLimitGb: null, resetPolicy: 'never', allowedServers: [server.id], allowedProtocols: ['xray', 'amneziawg'] });
  const d1 = repo.insertDevice({ userId: user.id, name: 'X1', serverId: server.id, protocol: 'xray', uuid: 'u1', publicKey: 'p1', link: 'vless://1' });
  const d2 = repo.insertDevice({ userId: user.id, name: 'X2', serverId: server.id, protocol: 'xray', uuid: 'u2', publicKey: 'p2', link: 'vless://2' });
  repo.updateDeviceFields(d1.id, { received_bytes: 3 * GB, sent_bytes: 1 * GB, traffic_gb: 4 });
  repo.updateDeviceFields(d2.id, { received_bytes: 10 * GB, sent_bytes: 2 * GB, traffic_gb: 12 });
  const proxy = repo.insertProxyAccountRow({ userId: user.id, serverId: server.id, login: 'px', passEnc: encryptSecret('p') });
  repo.updateProxyAccountTraffic(proxy.id, { receivedBytes: 5 * GB, sentBytes: 0, rxRaw: 5 * GB });
  // 4 + 12 + 5 = 21 ГБ
  assert.ok(Math.abs(repo.serverTrafficGb(server.id) - 21) < 1e-6, `итог = сумма всех устройств + прокси, факт ${repo.serverTrafficGb(server.id)}`);
});

test('частичный замер НЕ обнуляет итог: не увиденное устройство сохраняет вклад', () => {
  const server = repo.insertServer({ name: 'HOME', country: 'RU', host: '10.9.0.2', protocols: ['xray'], endpointOk: true });
  const user = repo.insertUser({ name: 'U2', comment: '', category: null, tags: [], code: 'st2', deviceLimit: null, expiresAt: null, trafficLimitGb: null, resetPolicy: 'never', allowedServers: [server.id], allowedProtocols: ['xray'] });
  const a = repo.insertDevice({ userId: user.id, name: 'A', serverId: server.id, protocol: 'xray', uuid: 'a', publicKey: 'pa', link: 'v://a' });
  const b = repo.insertDevice({ userId: user.id, name: 'B', serverId: server.id, protocol: 'xray', uuid: 'b', publicKey: 'pb', link: 'v://b' });
  repo.updateDeviceFields(a.id, { received_bytes: 100 * GB, sent_bytes: 0, traffic_gb: 100 });
  repo.updateDeviceFields(b.id, { received_bytes: 200 * GB, sent_bytes: 0, traffic_gb: 200 });
  const before = repo.serverTrafficGb(server.id); // 300
  // Следующий цикл синка «увидел» только устройство A (B офлайн/не попал в замер): обновляем лишь A.
  repo.updateDeviceFields(a.id, { received_bytes: 101 * GB, sent_bytes: 0, traffic_gb: 101 });
  const after = repo.serverTrafficGb(server.id); // 101 + 200 = 301, а НЕ 101
  assert.ok(Math.abs(before - 300) < 1e-6, `было 300, факт ${before}`);
  assert.ok(Math.abs(after - 301) < 1e-6, `итог включает не увиденное устройство B: ждём 301, факт ${after}`);
  assert.ok(after > before, 'итог монотонно вырос, не схлопнулся');
});
