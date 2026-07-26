// Самотест изоляции базы: подтверждение персистентности и отсутствие ложных
// тревог вне контейнера.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = path.join(os.tmpdir(), `novpn-dbh-${process.pid}-${Math.floor(process.hrtime()[1])}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.DATABASE_PATH = path.join(tmp, 'database.sqlite');
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.SESSION_SECRET = 'test-secret';

const { checkDbIsolation } = await import('../src/services/dbHealth.js');

test('данные старше процесса → персистентность подтверждена', () => {
  const old = new Date(Date.now() - 24 * 3600 * 1000).toISOString(); // сутки назад
  const h = checkDbIsolation(old);
  assert.equal(h.confirmedPersistent, true);
  assert.equal(h.risky, false);
});

test('нет старых данных → не подтверждена (но вне контейнера тревоги нет)', () => {
  const h = checkDbIsolation(null);
  // Тест не в контейнере → risky всегда false, ложной тревоги быть не должно.
  assert.equal(h.container, false);
  assert.equal(h.risky, false);
});

test('в отчёте есть путь к базе', () => {
  const h = checkDbIsolation(null);
  assert.ok(h.dbPath.endsWith('database.sqlite'));
});
