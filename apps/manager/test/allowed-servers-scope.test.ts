// Регресс на обход снятия доступа: пустой allowedServers = «ни одного сервера».
// Прежний `.size > 0` инвертировал пустой список в «все» — снятие всех серверов у
// профиля не убирало уже выданные Xray-конфиги из подписки (и не помечало на отзыв).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = path.join(os.tmpdir(), `novpn-scope-${process.pid}-${Math.floor(process.hrtime()[1])}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.DATABASE_PATH = path.join(tmp, 'database.sqlite');
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.SESSION_SECRET = 'test-secret';

const repo = await import('../src/repo.js');

let seq = 0;
function setup() {
  seq += 1;
  const s1 = repo.insertServer({ name: `S1-${seq}`, country: 'FI', host: `10.0.9.${seq * 2}`, protocols: ['xray'], endpointOk: true });
  const s2 = repo.insertServer({ name: `S2-${seq}`, country: 'NL', host: `10.0.9.${seq * 2 + 1}`, protocols: ['xray'], endpointOk: true });
  const user = repo.insertUser({
    name: `Scope-${seq}`, comment: '', category: null, tags: [], code: `sc${String(seq).padStart(4, '0')}`,
    deviceLimit: null, expiresAt: null, trafficLimitGb: null, resetPolicy: 'never',
    allowedServers: [s1.id, s2.id], allowedProtocols: ['xray'],
  });
  repo.insertDevice({ userId: user.id, name: 'Dev1', serverId: s1.id, protocol: 'xray', uuid: `u-sc-${seq}-1`, publicKey: 'pbk1', link: `vless://u-sc-${seq}-1@h1` });
  repo.insertDevice({ userId: user.id, name: 'Dev2', serverId: s2.id, protocol: 'xray', uuid: `u-sc-${seq}-2`, publicKey: 'pbk2', link: `vless://u-sc-${seq}-2@h2` });
  return { s1, s2, user };
}

test('оба сервера разрешены → подписка отдаёт оба конфига', () => {
  const { user } = setup();
  const entries = repo.subscriptionXrayEntries(user.id);
  assert.equal(entries.length, 2);
});

test('снятие ВСЕХ серверов (allowedServers=[]) → подписка пуста', () => {
  const { user } = setup();
  repo.updateUserFields(user.id, { allowed_servers: JSON.stringify([]) });
  const entries = repo.subscriptionXrayEntries(user.id);
  assert.equal(entries.length, 0, 'пустой allowedServers должен означать «ни одного сервера»');
});

test('сужение до одного сервера → только его конфиг', () => {
  const { s1, user } = setup();
  repo.updateUserFields(user.id, { allowed_servers: JSON.stringify([s1.id]) });
  const entries = repo.subscriptionXrayEntries(user.id);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.serverId, s1.id);
});
