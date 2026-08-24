// Регрессии по адверсариал-аудиту серверного жизненного цикла:
//  #1 awgParamsFromDevice — параметры обфускации восстанавливаются из выданного конфига,
//     когда keyvault пуст (иначе миграция на новый бокс ломала бы все AWG-конфиги);
//  #2 deleteServer вычищает id из allowed_servers (иначе фантом-сервер в выдаче + бот);
//  #3 getServerDevicesForResync НЕ воскрешает quota_blocked пиров (обход лимита).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = path.join(os.tmpdir(), `novpn-lifecycle-${process.pid}-${Math.floor(process.hrtime()[1])}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.DATABASE_PATH = path.join(tmp, 'database.sqlite');
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.SESSION_SECRET = 'test-secret';

const repo = await import('../src/repo.js');

let seq = 0;
function mkUser(allowed: string[]) {
  seq += 1;
  return repo.insertUser({
    name: `U${seq}`, comment: '', category: null, tags: [], code: `lc${seq}`,
    deviceLimit: null, expiresAt: null, trafficLimitGb: null, resetPolicy: 'never',
    allowedServers: allowed, allowedProtocols: ['xray', 'amneziawg'],
  });
}

test('#1 awgParamsFromDevice: тащит Jc..H4 из выданного AWG-конфига', () => {
  const srv = repo.insertServer({ name: 'FR', country: 'FR', host: '10.1.0.1', protocols: ['amneziawg'], endpointOk: true });
  const u = mkUser([srv.id]);
  const conf = ['[Interface]', 'PrivateKey = abc', 'Address = 10.8.1.7/32', 'DNS = 1.1.1.1',
    'Jc = 4', 'Jmin = 40', 'Jmax = 70', 'S1 = 86', 'S2 = 97',
    'H1 = 1004746675', 'H2 = 928473625', 'H3 = 1719083348', 'H4 = 1339303396',
    '[Peer]', 'PublicKey = srvpub', 'Endpoint = 10.1.0.1:51820', 'AllowedIPs = 0.0.0.0/0'].join('\n');
  repo.insertDevice({ userId: u.id, name: 'Тел', serverId: srv.id, protocol: 'amneziawg', publicKey: 'cpub', clientIp: '10.8.1.7/32', conf });
  const p = repo.awgParamsFromDevice(srv.id);
  assert.ok(p, 'параметры должны извлечься');
  assert.deepEqual(p, { Jc: 4, Jmin: 40, Jmax: 70, S1: 86, S2: 97, H1: 1004746675, H2: 928473625, H3: 1719083348, H4: 1339303396 });
  // Нет AWG-устройств → null (не выдумываем)
  const empty = repo.insertServer({ name: 'X', country: null, host: '10.1.0.9', protocols: ['xray'], endpointOk: true });
  assert.equal(repo.awgParamsFromDevice(empty.id), null);
});

test('#2 deleteServer вычищает id из allowed_servers у всех пользователей', () => {
  const s1 = repo.insertServer({ name: 'S1', country: null, host: '10.2.0.1', protocols: ['xray'], endpointOk: true });
  const s2 = repo.insertServer({ name: 'S2', country: null, host: '10.2.0.2', protocols: ['xray'], endpointOk: true });
  const u = mkUser([s1.id, s2.id]);
  assert.deepEqual(repo.getUser(u.id)!.allowedServers.sort(), [s1.id, s2.id].sort());
  repo.deleteServer(s1.id);
  const after = repo.getUser(u.id)!.allowedServers;
  assert.deepEqual(after, [s2.id], 'удалённый сервер должен исчезнуть из allowed_servers, s2 остаётся');
});

test('#3 getServerDevicesForResync НЕ включает quota_blocked пиров', () => {
  const srv = repo.insertServer({ name: 'Q', country: null, host: '10.3.0.1', protocols: ['amneziawg'], endpointOk: true });
  const u = mkUser([srv.id]);
  const ok = repo.insertDevice({ userId: u.id, name: 'OK', serverId: srv.id, protocol: 'amneziawg', publicKey: 'p-ok', clientIp: '10.8.1.2/32' });
  const blocked = repo.insertDevice({ userId: u.id, name: 'BLK', serverId: srv.id, protocol: 'amneziawg', publicKey: 'p-blk', clientIp: '10.8.1.3/32' });
  repo.setQuotaBlocked(blocked.id, true);
  const resync = repo.getServerDevicesForResync(srv.id).map((d) => d.publicKey);
  assert.ok(resync.includes('p-ok'), 'обычный пир восстанавливается');
  assert.ok(!resync.includes('p-blk'), 'quota_blocked пир НЕ восстанавливается (иначе обход лимита)');
  assert.ok(ok && blocked);
});
