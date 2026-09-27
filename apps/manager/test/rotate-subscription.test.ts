// Перевыпуск подписки: после него у того, с кем поделились, не должно остаться
// ни рабочего адреса подписки, ни личной ссылки, ни ключей Xray, ни прокси, ни входа
// в кабинет. SSH подменён фейками — проверяем логику и состояние базы.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = path.join(os.tmpdir(), `novpn-rotate-${process.pid}-${Math.floor(process.hrtime()[1])}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.DATABASE_PATH = path.join(tmp, 'database.sqlite');
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.SESSION_SECRET = 'test-secret';

const repo = await import('../src/repo.js');
const { db } = await import('../src/db.js');
const { destroyUserSessions } = await import('../src/services/sessionStore.js');
const { rotateSubscription, selfRotateWaitMin, SELF_ROTATE_COOLDOWN_MIN } = await import('../src/services/rotate.js');
type Deps = import('../src/services/rotate.js').RotateDeps;

let seq = 0;
function seed() {
  seq += 1;
  const a = repo.insertServer({ name: `A${seq}`, country: 'FI', host: `10.0.2.${seq}`, protocols: ['xray', 'amneziawg'], endpointOk: true });
  const b = repo.insertServer({ name: `B${seq}`, country: 'NL', host: `10.0.3.${seq}`, protocols: ['xray'], endpointOk: true });
  const user = repo.insertUser({
    name: `R${seq}`, comment: '', category: null, tags: [], code: `r${seq}`,
    deviceLimit: null, expiresAt: null, trafficLimitGb: null, resetPolicy: 'never',
    allowedServers: [a.id, b.id], allowedProtocols: ['xray', 'amneziawg'],
  });
  const xa = repo.insertDevice({ userId: user.id, name: 'Телефон', serverId: a.id, protocol: 'xray', uuid: `old-a-${seq}`, publicKey: 'pbk', link: `vless://old-a-${seq}@a` });
  const xb = repo.insertDevice({ userId: user.id, name: 'Телефон', serverId: b.id, protocol: 'xray', uuid: `old-b-${seq}`, publicKey: 'pbk', link: `vless://old-b-${seq}@b` });
  const awg = repo.insertDevice({ userId: user.id, name: 'Ноут', serverId: a.id, protocol: 'amneziawg', publicKey: `wg-${seq}`, clientIp: `10.8.1.${seq}/32`, link: null });
  const px = repo.insertProxyAccountRow({ userId: user.id, serverId: a.id, login: `old${seq}`, passEnc: 'x' });
  return { a, b, user, xa, xb, awg, px };
}

function session(sid: string, sess: Record<string, unknown>) {
  db.prepare('INSERT INTO sessions(sid,sess,expire) VALUES(?,?,?)').run(sid, JSON.stringify({ cookie: {}, ...sess }), Date.now() + 3600_000);
}
const devRow = (id: string) => db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as any;
const sessionExists = (sid: string) => !!db.prepare('SELECT 1 FROM sessions WHERE sid = ?').get(sid);

function fakes(over: Partial<Deps> = {}) {
  const calls = { revokedXray: [] as string[], revokedProxy: [] as string[], notified: [] as string[] };
  let n = 0;
  const deps: Deps = {
    hasSsh: async () => true,
    revokeXray: async (_s, uuid) => { calls.revokedXray.push(uuid); },
    createXray: async (s) => { n += 1; return { uuid: `new-${s.name}-${n}`, publicKey: 'pbk2', link: `vless://new-${s.name}-${n}@x` }; },
    revokeProxy: async (_s, login) => { calls.revokedProxy.push(login); },
    issueProxy: async (u, serverId) => repo.insertProxyAccountRow({ userId: u.id, serverId, login: `new${n}`, passEnc: 'y' }),
    notify: async (_id, text) => { calls.notified.push(text); return true; },
    destroySessions: destroyUserSessions,
    ...over,
  };
  return { deps, calls };
}

test('полный перевыпуск: новые адреса, ключи Xray, прокси; чужие входы закрыты, свой остаётся', async () => {
  const s = seed();
  const oldSub = repo.getSubToken(s.user.id)!;
  const oldAccess = repo.getAccessToken(s.user.id)!;
  session(`mine-${seq}`, { userId: s.user.id });
  session(`friend-${seq}`, { userId: s.user.id });
  session(`admin-${seq}`, { admin: true, userId: s.user.id });
  const { deps, calls } = fakes();

  const r = await rotateSubscription(s.user.id, { origin: 'https://panel.test', keepSid: `mine-${seq}`, by: 'user' }, deps);

  assert.equal(repo.getUserBySubToken(oldSub), null, 'старый адрес подписки не должен работать');
  assert.equal(repo.getUserByAccessToken(oldAccess), null, 'старая личная ссылка не должна работать');
  assert.equal(r.accessLink, `https://panel.test/k/${repo.getAccessToken(s.user.id)}`);
  assert.equal(r.subLink, `https://panel.test/sub/${repo.getSubToken(s.user.id)}`);

  assert.deepEqual(calls.revokedXray.sort(), [`old-a-${seq}`, `old-b-${seq}`], 'старые UUID отозваны на серверах');
  assert.equal(r.rotated, 2);
  for (const id of [s.xa.id, s.xb.id]) {
    const row = devRow(id);
    assert.equal(row.is_active, 1);
    assert.match(row.uuid, /^new-/);
    assert.match(row.link, /^vless:\/\/new-/);
  }
  assert.equal(devRow(s.awg.id).public_key, `wg-${seq}`, 'AmneziaWG не трогаем — он поштучный');

  assert.deepEqual(calls.revokedProxy, [`old${seq}`]);
  assert.equal(r.proxiesRotated, 1);
  const proxies = repo.listProxyAccountRowsOfUser(s.user.id);
  assert.equal(proxies.length, 1);
  assert.notEqual(proxies[0]!.login, `old${seq}`, 'прокси выдан заново');

  assert.equal(r.sessionsClosed, 1);
  assert.ok(sessionExists(`mine-${seq}`), 'свой вход остаётся');
  assert.ok(!sessionExists(`friend-${seq}`), 'чужой вход закрыт');
  assert.ok(sessionExists(`admin-${seq}`), 'админскую сессию не трогаем');

  assert.deepEqual(r.failedServers, []);
  assert.equal(r.telegramNotified, true);
  assert.ok(calls.notified[0]!.includes(r.accessLink!), 'новая ссылка ушла в Telegram');
});

test('сервер недоступен: старый ключ снят в панели и стоит в очереди отзыва, остальные перевыпущены', async () => {
  const s = seed();
  const { deps } = fakes({ hasSsh: async (id) => id !== s.b.id });

  const r = await rotateSubscription(s.user.id, { origin: 'https://panel.test', by: 'admin' }, deps);

  assert.deepEqual(r.failedServers, [s.b.name]);
  assert.equal(r.rotated, 1);
  const rowB = devRow(s.xb.id);
  assert.equal(rowB.is_active, 0, 'из подписки уходит сразу');
  assert.equal(rowB.revoke_pending, 1, 'sync дожмёт отзыв старого UUID');
  assert.equal(rowB.uuid, `old-b-${seq}`, 'UUID сохранён — по нему sync и отзовёт');
  assert.ok(!repo.subscriptionXrayLinks(s.user.id).some((l) => l.includes('old-b')), 'старый ключ не раздаётся в подписке');
});

test('новый ключ не выдался: старый уже отозван, запись закрыта, сервер в списке неудач', async () => {
  const s = seed();
  const { deps } = fakes({
    createXray: async (srv) => {
      if (srv.id === s.a.id) throw new Error('boom');
      return { uuid: 'new-ok', publicKey: 'p', link: 'vless://new-ok@b' };
    },
  });

  const r = await rotateSubscription(s.user.id, { by: 'admin' }, deps);

  assert.deepEqual(r.failedServers, [s.a.name]);
  const rowA = devRow(s.xa.id);
  assert.equal(rowA.is_active, 0);
  assert.ok(rowA.revoked_at, 'отозван окончательно');
  assert.equal(devRow(s.xb.id).uuid, 'new-ok');
});

test('самостоятельный перевыпуск ограничен по частоте', async () => {
  const s = seed();
  assert.equal(selfRotateWaitMin(s.user.id), 0, 'первый раз — сразу');
  await rotateSubscription(s.user.id, { by: 'user' }, fakes().deps);
  assert.equal(selfRotateWaitMin(s.user.id), SELF_ROTATE_COOLDOWN_MIN);
  assert.equal(selfRotateWaitMin(s.user.id, Date.now() + (SELF_ROTATE_COOLDOWN_MIN + 1) * 60_000), 0, 'после паузы — снова можно');
});
