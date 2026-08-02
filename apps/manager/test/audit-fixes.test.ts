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
    allowedServers: [], defaultServerId: null, allowedProtocols: ['xray'],
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

test('findBotUser: legacy без chat_id матчится по handle (и только он)', () => {
  const u = mkUser({ telegram: '@legacy' }); // без setTelegramChatId
  assert.equal(repo.findBotUser(4004, '@legacy')?.id, u.id);
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
