// Публичный базовый URL: нормализация схемы и request-aware фолбэк (чтобы
// ссылки-подписки/личные ссылки не были битыми и не вели на localhost).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = path.join(os.tmpdir(), `novpn-url-${process.pid}-${Math.floor(process.hrtime()[1])}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.DATABASE_PATH = path.join(tmp, 'database.sqlite');
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.SESSION_SECRET = 'test';
process.env.PUBLIC_URL = 'http://localhost:3000';

const repo = await import('../src/repo.js');

function setDomain(d: string) {
  repo.saveSettings({ ...(repo.getSettings() as any), domain: d });
}

test('домен без схемы нормализуется в https://', () => {
  setDomain('panel.example.com');
  assert.equal(repo.publicBaseUrl(), 'https://panel.example.com');
});

test('домен со схемой сохраняется как есть', () => {
  setDomain('http://10.0.0.5:8080');
  assert.equal(repo.publicBaseUrl(), 'http://10.0.0.5:8080');
});

test('нет домена → используется request origin (а не localhost)', () => {
  setDomain('');
  assert.equal(repo.publicBaseUrl('https://mypanel.example.com'), 'https://mypanel.example.com');
});

test('нет домена и нет request origin → PUBLIC_URL из окружения', () => {
  setDomain('');
  assert.equal(repo.publicBaseUrl(), 'http://localhost:3000');
});

test('домен имеет приоритет над request origin', () => {
  setDomain('vpn.real.ru');
  assert.equal(repo.publicBaseUrl('https://attacker.example'), 'https://vpn.real.ru');
});
