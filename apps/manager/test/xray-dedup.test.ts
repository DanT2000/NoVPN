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

let seq = 0;
function seed() {
  seq += 1;
  const server = repo.insertServer({ name: 'FIN', country: 'FI', host: `10.0.0.${seq}`, protocols: ['xray'], endpointOk: true });
  const user = repo.insertUser({
    name: 'Тест', comment: '', category: null, tags: [], code: `code${seq}`,
    deviceLimit: 1, expiresAt: null, trafficLimitGb: null, resetPolicy: 'never',
    allowedServers: [server.id], defaultServerId: server.id, allowedProtocols: ['xray'],
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
