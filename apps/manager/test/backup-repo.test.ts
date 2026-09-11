// Резервный пул: общий пул виден только по «Приоритетному доступу», личная
// подписка — только владельцу; учёт внутреннего расхода и разбивка по людям.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = path.join(os.tmpdir(), `novpn-backup-${process.pid}-${Math.floor(process.hrtime()[1])}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.DATABASE_PATH = path.join(tmp, 'database.sqlite');
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.SESSION_SECRET = 'test';

const repo = await import('../src/repo.js');
const backup = await import('../src/backupRepo.js');

let codeSeq = 100000;
const mkUser = (name: string) =>
  repo.insertUser({
    name,
    comment: '',
    category: 'Общие',
    tags: [],
    code: String(codeSeq++),
    deviceLimit: null,
    expiresAt: null,
    trafficLimitGb: null,
    resetPolicy: 'never',
    allowedServers: [],
    allowedProtocols: ['xray'],
    allowedProxies: [],
    codeLoginEnabled: false,
  } as any);

const nodesOf = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    name: `S${i}`,
    link: `vless://uuid@s${i}.ext.example:443#S${i}`,
    host: `s${i}.ext.example`,
    port: 443,
    protocol: 'vless',
  }));

test('общий пул виден только при priorityAccess', () => {
  const priv = mkUser('Привилегированный');
  const plain = mkUser('Обычный');
  const shared = backup.insertBackupSubscription({ ownerUserId: null, title: 'Общий', url: 'https://prov.example/sub' });
  backup.setBackupFetchResult(shared.id, { format: 'plain', servers: nodesOf(3) });

  assert.equal(backup.backupServerLinksForUser(plain.id).length, 0, 'без привилегии — пусто');
  assert.equal(backup.userHasBackup(plain.id), false);

  repo.updateUserFields(priv.id, { priority_access: 1 });
  assert.equal(backup.backupServerLinksForUser(priv.id).length, 3, 'с привилегией — 3 сервера');
  assert.equal(backup.userHasBackup(priv.id), true);
});

test('личная подписка видна только владельцу и не требует привилегии', () => {
  const a = mkUser('А');
  const b = mkUser('Б');
  const personal = backup.insertBackupSubscription({ ownerUserId: a.id, title: 'Личная', url: 'https://prov.example/personal' });
  backup.setBackupFetchResult(personal.id, { format: 'plain', servers: nodesOf(2) });

  assert.equal(backup.backupServerLinksForUser(a.id).length, 2, 'владельцу — 2');
  assert.equal(backup.backupServerLinksForUser(b.id).length, 0, 'чужому — 0');
});

test('выключенная подписка выпадает из пула', () => {
  const u = mkUser('В');
  const sub = backup.insertBackupSubscription({ ownerUserId: u.id, url: 'https://prov.example/x' });
  backup.setBackupFetchResult(sub.id, { format: 'plain', servers: nodesOf(2) });
  assert.equal(backup.backupServerLinksForUser(u.id).length, 2);
  backup.updateBackupSubscription(sub.id, { enabled: 0 });
  assert.equal(backup.backupServerLinksForUser(u.id).length, 0);
});

test('ошибка фетча сохраняет прежние серверы и пишет last_error', () => {
  const sub = backup.insertBackupSubscription({ ownerUserId: null, url: 'https://prov.example/y' });
  backup.setBackupFetchResult(sub.id, { format: 'plain', servers: nodesOf(2) });
  assert.equal(backup.listBackupServers(sub.id).length, 2);
  backup.setBackupFetchResult(sub.id, { servers: [], error: 'провайдер ответил 500' });
  assert.equal(backup.listBackupServers(sub.id).length, 2, 'серверы не стёрты');
  assert.equal(backup.getBackupSubscription(sub.id)!.lastError, 'провайдер ответил 500');
});

test('внутренний учёт расхода накапливается и разбивается по людям', () => {
  const u1 = mkUser('Расход1');
  const u2 = mkUser('Расход2');
  const sub = backup.insertBackupSubscription({ ownerUserId: null, url: 'https://prov.example/z' });
  backup.addBackupTraffic(u1.id, sub.id, 1000);
  backup.addBackupTraffic(u1.id, sub.id, 500);
  backup.addBackupTraffic(u2.id, sub.id, 200);
  const by = backup.backupTrafficBySub(sub.id);
  assert.equal(by.length, 2);
  assert.equal(by[0].bytes, 1500, 'сортировка по расходу, первый — 1500');
  assert.equal(backup.getBackupSubscription(sub.id)!.internalBytes, 1700);
});

test('статистика провайдера из Subscription-Userinfo сохраняется', () => {
  const sub = backup.insertBackupSubscription({ ownerUserId: null, url: 'https://prov.example/stats' });
  backup.setBackupFetchResult(sub.id, {
    format: 'base64',
    servers: nodesOf(1),
    provider: { upload: 10, download: 20, total: 1000, expire: 1767225600 },
  });
  const s = backup.getBackupSubscription(sub.id)!;
  assert.equal(s.provider.download, 20);
  assert.equal(s.provider.total, 1000);
  assert.equal(s.provider.expire, 1767225600);
  assert.equal(s.serverCount, 1);
});
