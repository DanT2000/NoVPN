// Enforcement квоты AWG/Xray: устройства пользователей, исчерпавших лимит трафика,
// попадают в список «снять с сервера»; после восстановления лимита — в список «вернуть»
// (тем же ключом, без reissue). Плюс редактируемый список доменов обхода в конфиге.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = path.join(os.tmpdir(), `novpn-quota-${process.pid}-${Math.floor(process.hrtime()[1])}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.DATABASE_PATH = path.join(tmp, 'database.sqlite');
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.SESSION_SECRET = 'test-secret';

const repo = await import('../src/repo.js');
const { encryptSecret } = await import('../src/lib/crypto.js');

let seq = 0;
function seed(opts: { limit: number | null; used: number }) {
  seq += 1;
  const server = repo.insertServer({ name: 'FIN', country: 'FI', host: `10.0.1.${seq}`, protocols: ['xray', 'amneziawg'], endpointOk: true });
  const user = repo.insertUser({
    name: `U${seq}`, comment: '', category: null, tags: [], code: `q${seq}`,
    deviceLimit: null, expiresAt: null, trafficLimitGb: opts.limit, resetPolicy: 'never',
    allowedServers: [server.id], allowedProtocols: ['xray', 'amneziawg'],
  });
  repo.updateUserFields(user.id, { traffic_used_gb: opts.used });
  return { server, user };
}

test('over-quota Xray-устройство попадает в список на снятие; setQuotaBlocked убирает его', () => {
  const { server, user } = seed({ limit: 10, used: 12 });
  const dev = repo.insertDevice({ userId: user.id, name: 'Телефон', serverId: server.id, protocol: 'xray', uuid: 'uuid-q1', publicKey: 'pbk-q1', link: 'vless://uuid-q1@h' });
  const block = repo.listDevicesToBlockForQuota();
  assert.ok(block.some((d) => d.id === dev.id), 'устройство сверх лимита должно сниматься');
  repo.setQuotaBlocked(dev.id, true);
  assert.ok(!repo.listDevicesToBlockForQuota().some((d) => d.id === dev.id), 'после снятия повторно не блокируем');
});

test('устройство под лимитом НЕ снимается', () => {
  const { server, user } = seed({ limit: 100, used: 5 });
  const dev = repo.insertDevice({ userId: user.id, name: 'Ноут', serverId: server.id, protocol: 'amneziawg', publicKey: 'wg-ok', clientIp: '10.8.1.5/32', link: null });
  assert.ok(!repo.listDevicesToBlockForQuota().some((d) => d.id === dev.id));
});

test('безлимитный пользователь (limit=null) никогда не снимается', () => {
  const { server, user } = seed({ limit: null, used: 9999 });
  const dev = repo.insertDevice({ userId: user.id, name: 'ПК', serverId: server.id, protocol: 'xray', uuid: 'uuid-unl', publicKey: 'pbk-unl', link: 'vless://x' });
  assert.ok(!repo.listDevicesToBlockForQuota().some((d) => d.id === dev.id));
});

test('снятое устройство возвращается после восстановления лимита; psk расшифрован', () => {
  const { server, user } = seed({ limit: 10, used: 12 });
  const dev = repo.insertDevice({
    userId: user.id, name: 'AWG', serverId: server.id, protocol: 'amneziawg',
    publicKey: 'wg-restore', clientIp: '10.8.1.9/32', presharedKeyEnc: encryptSecret('psk-secret'), link: null,
  });
  repo.setQuotaBlocked(dev.id, true);
  // ещё сверх лимита → в списке восстановления быть не должно
  assert.ok(!repo.listDevicesToRestoreFromQuota().some((d) => d.id === dev.id));
  // лимит восстановлен (сброс трафика)
  repo.updateUserFields(user.id, { traffic_used_gb: 0 });
  const restore = repo.listDevicesToRestoreFromQuota();
  const item = restore.find((d) => d.id === dev.id);
  assert.ok(item, 'должно вернуться на сервер');
  assert.equal(item!.awgPub, 'wg-restore');
  assert.equal(item!.clientIp, '10.8.1.9/32');
  assert.equal(item!.psk, 'psk-secret', 'psk должен быть расшифрован для resync');
  repo.setQuotaBlocked(dev.id, false);
  assert.ok(!repo.listDevicesToRestoreFromQuota().some((d) => d.id === dev.id), 'после возврата повторно не восстанавливаем');
});

test('прокси-логины остаются вне enforcement AWG/Xray (не пересекаются)', () => {
  const { server, user } = seed({ limit: 10, used: 12 });
  const dev = repo.insertDevice({ userId: user.id, name: 'Xray', serverId: server.id, protocol: 'xray', uuid: 'uuid-mix', publicKey: 'pbk-mix', link: 'vless://y' });
  const block = repo.listDevicesToBlockForQuota();
  // список содержит только устройства (protocol xray/amneziawg), не прокси
  assert.ok(block.every((d) => d.protocol === 'xray' || d.protocol === 'amneziawg'));
  assert.ok(block.some((d) => d.id === dev.id));
});
