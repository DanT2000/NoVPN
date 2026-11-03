// 03.11.2026: после «Сохранить» в настройках бота админ видел «никто не привязан» — ответ
// брался из сохранённой копии, где linkedUserIds всегда пуст. Ответ должен совпадать с
// загрузкой страницы. Локальная панель на тестовой базе, вход тестовым паролем.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';

const tmp = path.join(os.tmpdir(), `novpn-tgsave-${process.pid}-${Math.floor(process.hrtime()[1])}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.DATABASE_PATH = path.join(tmp, 'database.sqlite');
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.SESSION_SECRET = 'test-secret';
process.env.ADMIN_PASSWORD = 'test-admin-pass-1'; // тестовый пароль локальной панели (не боевой)

const repo = await import('../src/repo.js');
const { createApp } = await import('../src/app.js');

test('после сохранения настроек бота привязанные пользователи на месте', async () => {
  const u = repo.insertUser({
    name: 'Владелец', comment: '', category: null, tags: [], code: 'tgsave1',
    deviceLimit: 1, expiresAt: null, trafficLimitGb: null, resetPolicy: 'never',
    allowedServers: [], allowedProtocols: ['xray'],
  });
  repo.setTelegramChatId(u.id, 123456789);
  repo.updateUserFields(u.id, { telegram: '@owner' }); // привязка через бота: chat_id + @username
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const login = await fetch(`${base}/api/admin/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'test-admin-pass-1' }),
    });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    assert.ok(cookie, 'вход админа на тестовой панели');
    const r = await fetch(`${base}/api/admin/telegram`, {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ enabled: false, mode: 'polling', proxyOn: true, proxySource: 'server', proxyServerIds: [], template: 'x' }),
    });
    assert.equal(r.status, 200);
    const tg = (await r.json()) as { linkedUserIds: string[]; tokenEnc?: string; proxyPassEnc?: string };
    assert.deepEqual(tg.linkedUserIds, [u.id], 'привязанный не пропал из ответа');
    assert.equal(tg.tokenEnc, undefined, 'секреты наружу не уходят');
    assert.equal(tg.proxyPassEnc, undefined);
  } finally {
    server.close();
  }
});
