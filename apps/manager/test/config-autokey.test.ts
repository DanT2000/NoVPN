// Установка без ENV: при отсутствии ENCRYPTION_KEY панель генерирует ключ сама и
// сохраняет его рядом с БД (стабилен между рестартами). Продвинутый ENV имеет приоритет.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = path.join(os.tmpdir(), `novpn-cfg-${process.pid}-${Math.floor(process.hrtime()[1])}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.DATABASE_PATH = path.join(tmp, 'database.sqlite');
process.env.SESSION_SECRET = '';
delete process.env.ENCRYPTION_KEY; // ключевой сценарий: ENV не задан

const { config } = await import('../src/config.js');

test('без ENCRYPTION_KEY: ключ сгенерирован (64 hex) и записан в data/encryption.key', () => {
  assert.match(config.encryptionKey, /^[0-9a-f]{64}$/);
  const keyFile = path.join(tmp, 'encryption.key');
  assert.ok(fs.existsSync(keyFile), 'файл ключа должен быть создан');
  assert.equal(fs.readFileSync(keyFile, 'utf8').trim(), config.encryptionKey);
});

test('sessionSecret выведен из ключа (не дефолтная небезопасная строка)', () => {
  assert.match(config.sessionSecret, /^[0-9a-f]{64}$/);
  assert.notEqual(config.sessionSecret, 'dev-insecure-session-secret-change-me');
});

test('appsDir и databasePath лежат в одном data-каталоге', () => {
  assert.equal(path.dirname(config.databasePath), path.dirname(config.appsDir));
});
