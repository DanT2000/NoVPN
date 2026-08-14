// Разбор команд бота: суффикс @botname (группы/подсказки), отделение payload,
// защита от ложных срабатываний на /configfoo.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = process.env.DATABASE_PATH || ':memory:';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0'.repeat(64);
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test';

const { parseCommand } = await import('../src/services/telegram.js');

test('parseCommand: /start без payload', () => {
  assert.deepEqual(parseCommand('/start'), { name: 'start', payload: '' });
});

test('parseCommand: /start с токеном', () => {
  assert.deepEqual(parseCommand('/start AbCd1234'), { name: 'start', payload: 'AbCd1234' });
});

test('parseCommand: /start@BotName с токеном (группы/подсказки)', () => {
  assert.deepEqual(parseCommand('/start@MyVpnBot AbCd1234'), { name: 'start', payload: 'AbCd1234' });
});

test('parseCommand: /menu и /config распознаются', () => {
  assert.equal(parseCommand('/menu')?.name, 'menu');
  assert.equal(parseCommand('/config')?.name, 'config');
  assert.equal(parseCommand('/config@MyVpnBot')?.name, 'config');
});

test('parseCommand: /id распознаётся (узнать Telegram ID)', () => {
  assert.equal(parseCommand('/id')?.name, 'id');
  assert.equal(parseCommand('/id@MyVpnBot')?.name, 'id');
  assert.equal(parseCommand('/identity'), null); // не ложное срабатывание
});

test('parseCommand: /configfoo НЕ команда (ложное срабатывание)', () => {
  assert.equal(parseCommand('/configfoo'), null);
});

test('parseCommand: произвольный текст (код/токен) — не команда', () => {
  assert.equal(parseCommand('482915'), null);
  assert.equal(parseCommand('какой-то текст'), null);
});
