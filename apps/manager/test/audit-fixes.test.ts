// Регресс на находки аудита: идентификация в боте по chat_id (защита от захвата
// через переиспользуемый @username), блок выдачи при исчерпанной квоте,
// наполнение linkedUserIds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = path.join(os.tmpdir(), `novpn-audit-${process.pid}-${Math.floor(process.hrtime()[1])}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.DATABASE_PATH = path.join(tmp, 'database.sqlite');
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.SESSION_SECRET = 'test';

const repo = await import('../src/repo.js');
const { issueForUser } = await import('../src/services/issue.js');

let seq = 0;
function mkUser(extra: Record<string, unknown> = {}) {
  seq += 1;
  const u = repo.insertUser({
    name: `U${seq}`, comment: '', category: null, tags: [], code: `c${seq}`,
    deviceLimit: null, expiresAt: null, trafficLimitGb: null, resetPolicy: 'never',
    allowedServers: [], allowedProtocols: ['xray'],
  });
  if (Object.keys(extra).length) repo.updateUserFields(u.id, extra);
  return repo.getUser(u.id)!;
}

test('findBotUser: резолв по chat_id (безопасно)', () => {
  const u = mkUser({ telegram: '@alice' });
  repo.setTelegramChatId(u.id, 1001);
  assert.equal(repo.findBotUser(1001, '@alice')?.id, u.id);
  assert.equal(repo.getUserByTelegramChatId(1001)?.id, u.id);
});

test('findBotUser: чужой chatId с занятым @username НЕ захватывает привязанного', () => {
  const u = mkUser({ telegram: '@victim' });
  repo.setTelegramChatId(u.id, 2002);
  // атакующий занял освободившийся @victim, у него ДРУГОЙ chatId
  assert.equal(repo.findBotUser(3003, '@victim'), null);
});

test('findBotUser: legacy по @username больше НЕ идентифицируется (защита от захвата)', () => {
  // username в Telegram переиспользуемы: идентификация по handle позволяла бы
  // новому владельцу @username захватить аккаунт. Теперь — только по chat_id.
  const u = mkUser({ telegram: '@legacy' }); // без setTelegramChatId
  assert.equal(repo.findBotUser(4004, '@legacy'), null);
  // после явной привязки (токен/код → chat_id) — резолвится нормально
  repo.setTelegramChatId(u.id, 4004);
  assert.equal(repo.findBotUser(4004, '@legacy')?.id, u.id);
});

test('setTelegramChatId: один chat_id принадлежит ровно одному пользователю', () => {
  const a = mkUser();
  const b = mkUser();
  repo.setTelegramChatId(a.id, 7007);
  assert.equal(repo.getUserByTelegramChatId(7007)?.id, a.id);
  // привязали тот же chat_id к b — с a он должен сняться (резолв теперь b, не a)
  repo.setTelegramChatId(b.id, 7007);
  assert.equal(repo.getUserByTelegramChatId(7007)?.id, b.id);
});

test('getUserByTelegramChatId: удалённый пользователь не резолвится', () => {
  const u = mkUser();
  repo.setTelegramChatId(u.id, 8008);
  repo.softDeleteUser(u.id);
  assert.equal(repo.getUserByTelegramChatId(8008), null);
});

test('listTelegramTargets: только активные, не удалённые, без дублей chat_id', () => {
  const a = mkUser({ telegram: '@t1' });
  const b = mkUser({ telegram: '@t2' });
  const c = mkUser({ telegram: '@t3' });
  repo.setTelegramChatId(a.id, 9001);
  repo.setTelegramChatId(b.id, 9002);
  repo.setTelegramChatId(c.id, 9003);
  repo.updateUserFields(b.id, { is_active: 0 }); // выключен
  repo.softDeleteUser(c.id); // удалён
  const chatIds = repo.listTelegramTargets().map((t) => t.chatId);
  assert.ok(chatIds.includes(9001));
  assert.ok(!chatIds.includes(9002));
  assert.ok(!chatIds.includes(9003));
  // без дублей
  assert.equal(new Set(chatIds).size, chatIds.length);
});

test('deleteDevice: трафик не «возвращается» — списывается в retired_traffic_gb', () => {
  const server = repo.insertServer({ name: 'S', country: null, host: 'h', protocols: ['xray'], endpointOk: true });
  const u = mkUser({ allowed_servers: JSON.stringify([server.id]) });
  const dev = repo.insertDevice({ userId: u.id, name: 'd', serverId: server.id, protocol: 'xray' });
  repo.updateDeviceFields(dev.id, { traffic_gb: 5 });
  repo.recomputeUserUsage(u.id);
  assert.equal(repo.getUser(u.id)!.trafficUsedGb, 5);
  // Удаление конфига НЕ должно вернуть квоту: расход сохраняется через retired.
  repo.deleteDevice(dev.id);
  assert.equal(repo.getUser(u.id)!.trafficUsedGb, 5);
});

test('cleanupRevokedDevices: удаляет старое отозванное, свежее (в grace) оставляет', () => {
  const server = repo.insertServer({ name: 'S', country: null, host: 'h', protocols: ['xray'], endpointOk: true });
  const u = mkUser({ allowed_servers: JSON.stringify([server.id]) });
  const oldDev = repo.insertDevice({ userId: u.id, name: 'old', serverId: server.id, protocol: 'xray' });
  const freshDev = repo.insertDevice({ userId: u.id, name: 'fresh', serverId: server.id, protocol: 'xray' });
  const longAgo = new Date(Date.now() - 10 * 86400000).toISOString();
  repo.updateDeviceFields(oldDev.id, { is_active: 0, revoked_at: longAgo });
  repo.updateDeviceFields(freshDev.id, { is_active: 0, revoked_at: new Date().toISOString() });
  const removed = repo.cleanupRevokedDevices(3);
  assert.equal(removed, 1);
  assert.equal(repo.getDevice(oldDev.id), null); // старое удалено
  assert.ok(repo.getDevice(freshDev.id)); // свежее в grace — осталось
});

test('subscriptionXrayLinks: один конфиг на сервер (дедуп дублей)', () => {
  const s1 = repo.insertServer({ name: 'S1', country: null, host: 'h1', protocols: ['xray'], endpointOk: true });
  const s2 = repo.insertServer({ name: 'S2', country: null, host: 'h2', protocols: ['xray'], endpointOk: true });
  const u = mkUser({ allowed_servers: JSON.stringify([s1.id, s2.id]) });
  // 3 активных Xray-дубля на s1 + 1 на s2 + один отозванный на s1
  const d1 = repo.insertDevice({ userId: u.id, name: 'a', serverId: s1.id, protocol: 'xray', uuid: 'x1', link: 'vless://x1@h1' });
  const d2 = repo.insertDevice({ userId: u.id, name: 'b', serverId: s1.id, protocol: 'xray', uuid: 'x2', link: 'vless://x2@h1' });
  const d3 = repo.insertDevice({ userId: u.id, name: 'c', serverId: s1.id, protocol: 'xray', uuid: 'x3', link: 'vless://x3@h1' });
  repo.insertDevice({ userId: u.id, name: 'd', serverId: s2.id, protocol: 'xray', uuid: 'x4', link: 'vless://x4@h2' });
  const revoked = repo.insertDevice({ userId: u.id, name: 'e', serverId: s1.id, protocol: 'xray', uuid: 'x5', link: 'vless://x5@h1' });
  repo.updateDeviceFields(revoked.id, { is_active: 0, revoked_at: repo.nowIso() });
  const links = repo.subscriptionXrayLinks(u.id);
  // ровно 2: по одному на s1 и s2; отозванный не попал
  assert.equal(links.length, 2);
  assert.ok(links.some((l) => l.endsWith('@h2'))); // s2 представлен
  assert.equal(links.filter((l) => l.endsWith('@h1')).length, 1); // с s1 ровно один
  // дубли d1/d2/d3 существуют, но в подписке — один из них
  assert.ok([d1, d2, d3].some((d) => links.includes(d.link!)));
});

test('issueForUser: лимит устройств блокирует выпуск (путь бота в обход UI)', async () => {
  const server = repo.insertServer({ name: 'S', country: null, host: 'h', protocols: ['amneziawg'], endpointOk: true });
  repo.updateServerFields(server.id, { auto_issue: 1 });
  const u = mkUser({ allowed_servers: JSON.stringify([server.id]), allowed_protocols: JSON.stringify(['amneziawg']), device_limit: 0 });
  await assert.rejects(() => issueForUser(u, 'dev', server.id, 'amneziawg'), /лимит устройств/i);
});

test('linkedUserIds наполняется из привязанных пользователей', () => {
  const a = mkUser({ telegram: '@x1' });
  mkUser(); // без привязки
  const ids = repo.getTelegramSafe().linkedUserIds;
  assert.ok(ids.includes(a.id));
  assert.equal(repo.listUsers().filter((u) => u.telegram).length, ids.length);
});

test('issueForUser: исчерпанная квота блокирует выпуск ДО обращения к серверу', async () => {
  const server = repo.insertServer({ name: 'S', country: null, host: 'h', protocols: ['xray'], endpointOk: true });
  const u = mkUser({ allowed_servers: JSON.stringify([server.id]), traffic_limit_gb: 1, traffic_used_gb: 2 });
  await assert.rejects(() => issueForUser(u, 'dev', server.id, 'xray'), /Лимит трафика/);
});

test('issueForUser: админ (byAdmin) квотой не ограничен на этапе проверок', async () => {
  const server = repo.insertServer({ name: 'S', country: null, host: 'h', protocols: ['xray'], endpointOk: true });
  const u = mkUser({ allowed_servers: JSON.stringify([server.id]), traffic_limit_gb: 1, traffic_used_gb: 2 });
  // byAdmin проходит проверку квоты; дальше упрётся в отсутствие SSH/ключей — но НЕ в квоту.
  await assert.rejects(() => issueForUser(u, 'dev', server.id, 'xray', { byAdmin: true }), (e: Error) => !/Лимит трафика/.test(e.message));
});
