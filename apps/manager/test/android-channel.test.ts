// Канал Android: своя папка — раздаём сами; нет папки — отправляем на центральную панель
// (у Роберта /android/latest.json отдавал HTML главной, и приложение не видело обновлений).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server as HttpServer } from 'node:http';

const tmp = path.join(os.tmpdir(), `novpn-android-${process.pid}-${Math.floor(process.hrtime()[1])}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.DATABASE_PATH = path.join(tmp, 'database.sqlite');
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.SESSION_SECRET = 'test-secret';
const androidDir = path.join(tmp, 'android');
process.env.ANDROID_DIR = androidDir;
process.env.ANDROID_UPSTREAM = 'https://central.example';

const { seedIfEmpty } = await import('../src/seed.js');
const { createApp, androidUpstreamUrl } = await import('../src/app.js');
seedIfEmpty();

let server: HttpServer;
let base = '';
before(async () => {
  server = createApp().listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server?.close();
});

test('адрес перенаправления: только имя файла, только GET/HEAD, не на себя', () => {
  assert.equal(androidUpstreamUrl('https://central.example', 'robert.example', 'GET', '/latest.json'), 'https://central.example/android/latest.json');
  assert.equal(androidUpstreamUrl('https://central.example/', 'robert.example', 'HEAD', '/novpn.apk'), 'https://central.example/android/novpn.apk');
  assert.equal(androidUpstreamUrl('https://central.example', 'central.example', 'GET', '/latest.json'), null, 'центральная сама на себя не шлёт');
  assert.equal(androidUpstreamUrl('https://central.example', 'robert.example', 'POST', '/latest.json'), null);
  assert.equal(androidUpstreamUrl('', 'robert.example', 'GET', '/latest.json'), null, 'выключено');
  assert.equal(androidUpstreamUrl('javascript:alert(1)', 'robert.example', 'GET', '/latest.json'), null);
  for (const bad of ['/', '/a/b.apk', '/..', '/a%2Fb', '/x?y', '//evil.example/x']) {
    assert.equal(androidUpstreamUrl('https://central.example', 'robert.example', 'GET', bad), null, bad);
  }
});

test('своего канала нет — /android/* уходит на центральную панель (302)', async () => {
  assert.equal(fs.existsSync(androidDir), false);
  const r = await fetch(`${base}/android/latest.json`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), 'https://central.example/android/latest.json');
  const apk = await fetch(`${base}/android/novpn.apk`, { redirect: 'manual' });
  assert.equal(apk.headers.get('location'), 'https://central.example/android/novpn.apk');
  // Не имя файла — честный 404, а не HTML главной и не перенаправление.
  const bad = await fetch(`${base}/android/a/b.apk`, { redirect: 'manual' });
  assert.equal(bad.status, 404);
});

test('свой канал появился на томе — раздаём сами, без перезапуска', async () => {
  fs.mkdirSync(androidDir, { recursive: true });
  fs.writeFileSync(path.join(androidDir, 'latest.json'), '{"version":"0.2.16","versionCode":18}');
  const r = await fetch(`${base}/android/latest.json`, { redirect: 'manual' });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') ?? '', /application\/json/);
  assert.deepEqual(await r.json(), { version: '0.2.16', versionCode: 18 });
  const missing = await fetch(`${base}/android/novpn.apk`, { redirect: 'manual' });
  assert.equal(missing.status, 404, 'своего файла нет — не уходим на центральную');
});
