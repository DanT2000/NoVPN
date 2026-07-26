// Прокси-аккаунты: доступные типы (права ∩ установлено), CRUD, сборка view с
// эндпоинтами по портам сервера и разрешениям пользователя.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = path.join(os.tmpdir(), `novpn-px-${process.pid}-${Math.floor(process.hrtime()[1])}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.DATABASE_PATH = path.join(tmp, 'database.sqlite');
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.SESSION_SECRET = 'test-secret';

const repo = await import('../src/repo.js');
const kv = await import('../src/services/keyvault.js');
const { encryptSecret } = await import('../src/lib/crypto.js');

let seq = 0;
function seed(allowedProxies: Array<'http' | 'https' | 'socks5'>) {
  seq += 1;
  const server = repo.insertServer({
    name: `S${seq}`, country: null, host: `px${seq}.example`, protocols: ['http', 'socks5', 'https'], endpointOk: true,
  });
  kv.saveServerProxy(server.host, {
    user: 'novpn', pass: 'shared', httpPort: 8080, socksPort: 1080, httpsPort: 8443, httpsHost: `secure-${server.host}`,
  });
  const user = repo.insertUser({
    name: `U${seq}`, comment: '', category: null, tags: [], code: `c${seq}`,
    deviceLimit: null, expiresAt: null, trafficLimitGb: null, resetPolicy: 'never',
    allowedServers: [server.id], defaultServerId: server.id, allowedProtocols: ['xray'], allowedProxies,
  });
  return { server, user };
}

test('availableProxyTypes = разрешено пользователю ∩ установлено на сервере', () => {
  const { server, user } = seed(['http', 'https']); // socks5 не разрешён пользователю
  const types = repo.availableProxyTypes(user, server);
  assert.deepEqual([...types].sort(), ['http', 'https']);
});

test('CRUD аккаунта: insert → findActive → deactivate', () => {
  const { server, user } = seed(['http']);
  const row = repo.insertProxyAccountRow({ userId: user.id, serverId: server.id, login: 'u-abc', passEnc: encryptSecret('secret123') });
  const found = repo.findActiveProxyAccount(user.id, server.id);
  assert.ok(found);
  assert.equal(found!.id, row.id);
  repo.deactivateProxyAccount(row.id);
  assert.equal(repo.findActiveProxyAccount(user.id, server.id), null);
});

test('buildProxyAccountView: пароль расшифрован, эндпоинты по правам пользователя', () => {
  const { server, user } = seed(['http', 'https']); // без socks
  const row = repo.insertProxyAccountRow({ userId: user.id, serverId: server.id, login: 'u-xyz', passEnc: encryptSecret('p@ss') });
  const view = repo.buildProxyAccountView(row)!;
  assert.equal(view.password, 'p@ss');
  const types = view.endpoints.map((e) => e.type).sort();
  assert.deepEqual(types, ['http', 'https']); // socks5 исключён — не разрешён пользователю
  const https = view.endpoints.find((e) => e.type === 'https')!;
  assert.equal(https.host, `secure-${server.host}`); // домен сертификата
  assert.equal(https.port, 8443);
  const http = view.endpoints.find((e) => e.type === 'http')!;
  assert.equal(http.port, 8080);
});
