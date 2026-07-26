// Цели экстренной рассылки: только пользователи с известным chat_id Telegram.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = path.join(os.tmpdir(), `novpn-bc-${process.pid}-${Math.floor(process.hrtime()[1])}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.DATABASE_PATH = path.join(tmp, 'database.sqlite');
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.SESSION_SECRET = 'test-secret';

const repo = await import('../src/repo.js');

let seq = 0;
function mkUser() {
  seq += 1;
  return repo.insertUser({
    name: `U${seq}`, comment: '', category: null, tags: [], code: `c${seq}`,
    deviceLimit: null, expiresAt: null, trafficLimitGb: null, resetPolicy: 'never',
    allowedServers: [], defaultServerId: null, allowedProtocols: ['xray'],
  });
}

test('listTelegramTargets возвращает только пользователей с chat_id', () => {
  const withTg = mkUser();
  mkUser(); // без привязки — не должен попасть
  repo.setTelegramChatId(withTg.id, 555001);
  const targets = repo.listTelegramTargets();
  assert.equal(targets.length, 1);
  assert.equal(targets[0]!.id, withTg.id);
  assert.equal(targets[0]!.chatId, 555001);
});

test('setTelegramChatId обновляет значение и не плодит дублей', () => {
  const u = mkUser();
  repo.setTelegramChatId(u.id, 111);
  repo.setTelegramChatId(u.id, 222); // смена chat_id
  const mine = repo.listTelegramTargets().filter((t) => t.id === u.id);
  assert.equal(mine.length, 1);
  assert.equal(mine[0]!.chatId, 222);
});
