// Рост «навсегда»: admin_log и user_history не прунились — admin_log рос без предела,
// а user_history вдобавок грузился ЦЕЛИКОМ на каждом bootstrap админки. Тесты
// подтверждают, что оба теперь ограничены.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = path.join(os.tmpdir(), `novpn-logprune-${process.pid}-${Math.floor(process.hrtime()[1])}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.DATABASE_PATH = path.join(tmp, 'database.sqlite');
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.SESSION_SECRET = 'test-secret';

const repo = await import('../src/repo.js');

test('admin_log ограничен ~2000 записями (кап на вставке)', () => {
  for (let i = 0; i < 2100; i++) repo.addLog(`строка ${i}`);
  const rows = repo.listLog(10000);
  assert.ok(rows.length <= 2000, `ожидалось ≤2000, получено ${rows.length}`);
  // самая свежая запись должна остаться (режем старые, не новые)
  assert.equal(rows[0]!.text, 'строка 2099');
});

test('user_history ограничен ~100 записями НА ПОЛЬЗОВАТЕЛЯ', () => {
  const u1 = repo.insertUser({
    name: 'H1', comment: '', category: null, tags: [], code: 'h001',
    deviceLimit: null, expiresAt: null, trafficLimitGb: null, resetPolicy: 'never',
    allowedServers: [], allowedProtocols: ['xray'],
  });
  const u2 = repo.insertUser({
    name: 'H2', comment: '', category: null, tags: [], code: 'h002',
    deviceLimit: null, expiresAt: null, trafficLimitGb: null, resetPolicy: 'never',
    allowedServers: [], allowedProtocols: ['xray'],
  });
  for (let i = 0; i < 150; i++) {
    repo.addHistory(u1.id, `u1 событие ${i}`);
    repo.addHistory(u2.id, `u2 событие ${i}`);
  }
  const h1 = repo.historyFor(u1.id);
  const h2 = repo.historyFor(u2.id);
  assert.ok(h1.length <= 100, `u1: ожидалось ≤100, получено ${h1.length}`);
  assert.ok(h2.length <= 100, `u2: ожидалось ≤100, получено ${h2.length}`);
  // прунинг ПО пользователю — самые свежие сохранены, чужие не тронуты
  assert.equal(h1[0]!.text, 'u1 событие 149');
  assert.equal(h2[0]!.text, 'u2 событие 149');
});
