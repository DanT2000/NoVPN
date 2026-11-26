// Зеркало канала Android (26.11.2026): панель без своих выпусков (у Роберта) сама скачивает
// APK с центральной и раздаёт со своего тома — ссылкой на свою панель можно делиться, а
// приложение у её людей обновляется с неё. Раз в час — сверка версии, файл качается только
// при новой; размер и sha256 из манифеста, без отката, атомарно.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server as HttpServer } from 'node:http';

// ── поддельная центральная панель ──
const central = {
  manifest: {} as Record<string, unknown>,
  apk: Buffer.alloc(0),
  apkHits: 0,
};
const apkOf = (s: string) => Buffer.from(`APK ${s} `.repeat(500));
const manifestOf = (version: string, code: number, apk: Buffer, extra: Record<string, unknown> = {}) => ({
  version,
  versionCode: code,
  url: '/android/novpn.apk',
  sha256: crypto.createHash('sha256').update(apk).digest('hex'),
  sizeBytes: apk.length,
  ...extra,
});
const publishCentral = (version: string, code: number, extra: Record<string, unknown> = {}) => {
  central.apk = apkOf(version);
  central.manifest = manifestOf(version, code, central.apk, extra);
};
const upstreamSrv = http.createServer((req, res) => {
  if (req.url === '/android/latest.json') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(central.manifest));
  }
  if (req.url === '/android/novpn.apk') {
    central.apkHits++;
    return res.end(central.apk);
  }
  res.statusCode = 404;
  res.end('');
});
upstreamSrv.listen(0, '127.0.0.1');
await new Promise<void>((r) => upstreamSrv.once('listening', () => r()));
const UPSTREAM = `http://127.0.0.1:${(upstreamSrv.address() as AddressInfo).port}`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'novpn-amirror-'));
const androidDir = path.join(tmp, 'android');
process.env.DATABASE_PATH = path.join(tmp, 'database.sqlite');
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.SESSION_SECRET = 'test-secret';
process.env.ANDROID_DIR = androidDir;
process.env.ANDROID_UPSTREAM = UPSTREAM;
process.env.PUBLIC_URL = 'https://robert.example';

const { seedIfEmpty } = await import('../src/seed.js');
const { createApp } = await import('../src/app.js');
const { androidMirrorCheck } = await import('../src/services/androidChannel.js');
seedIfEmpty();

let panel: HttpServer;
let base = '';
before(async () => {
  panel = createApp().listen(0);
  await new Promise<void>((r) => panel.once('listening', () => r()));
  base = `http://127.0.0.1:${(panel.address() as AddressInfo).port}`;
});
after(() => {
  panel?.close();
  upstreamSrv.close();
});

const local = () => JSON.parse(fs.readFileSync(path.join(androidDir, 'latest.json'), 'utf8'));
const localApk = () => fs.readFileSync(path.join(androidDir, 'novpn.apk'));

test('пока своего канала нет — перенаправление на центральную; папка без latest.json — тоже', async () => {
  const r = await fetch(`${base}/android/latest.json`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  // Зеркало создало папку и качает APK, а latest.json ещё нет: приложение не должно получить 404.
  fs.mkdirSync(androidDir, { recursive: true });
  const mid = await fetch(`${base}/android/latest.json`, { redirect: 'manual' });
  assert.equal(mid.status, 302);
  assert.equal(mid.headers.get('location'), `${UPSTREAM}/android/latest.json`);
  fs.rmSync(androidDir, { recursive: true, force: true });
});

test('первый запуск: скачали APK, проверили, раздаём со своего тома', async () => {
  publishCentral('0.2.16', 18);
  const r = await androidMirrorCheck();
  assert.deepEqual([r.ok, r.action, r.version], [true, 'mirrored', '0.2.16'], r.error);
  assert.ok(localApk().equals(central.apk));
  assert.equal(local().versionCode, 18);
  assert.equal(local().url, '/android/novpn.apk');
  const j = await fetch(`${base}/android/latest.json`, { redirect: 'manual' });
  assert.equal(j.status, 200, 'теперь отдаём сами, без перенаправления');
  const apk = await fetch(`${base}/android/novpn.apk`, { redirect: 'manual' });
  assert.equal(apk.status, 200);
  assert.ok(Buffer.from(await apk.arrayBuffer()).equals(central.apk));
});

test('та же версия — файл не качаем повторно', async () => {
  const hits = central.apkHits;
  const r = await androidMirrorCheck();
  assert.deepEqual([r.ok, r.action], [true, 'nochange']);
  assert.equal(central.apkHits, hits);
});

test('на центральной новее — обновляемся', async () => {
  publishCentral('0.2.17', 19);
  const r = await androidMirrorCheck();
  assert.deepEqual([r.action, r.version], ['mirrored', '0.2.17'], r.error);
  assert.ok(localApk().equals(central.apk));
  assert.equal(local().version, '0.2.17');
});

test('на центральной старее — не откатываемся', async () => {
  publishCentral('0.2.15', 17);
  const r = await androidMirrorCheck();
  assert.equal(r.action, 'nochange');
  assert.equal(local().version, '0.2.17');
});

test('sha256 не сошёлся — ничего не меняем', async () => {
  publishCentral('0.2.18', 20);
  central.manifest.sha256 = '0'.repeat(64);
  const before = localApk();
  const r = await androidMirrorCheck();
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /sha256/);
  assert.ok(localApk().equals(before));
  assert.equal(local().version, '0.2.17');
});

test('размер не сошёлся / подпись неверна / файл с чужого адреса — отказ', async () => {
  publishCentral('0.2.18', 20);
  central.manifest.sizeBytes = 5;
  assert.match((await androidMirrorCheck()).error ?? '', /размер/);
  publishCentral('0.2.18', 20, { signature: Buffer.alloc(64).toString('base64') });
  assert.match((await androidMirrorCheck()).error ?? '', /подпись/i);
  publishCentral('0.2.18', 20, { url: 'https://evil.example/novpn.apk' });
  assert.match((await androidMirrorCheck()).error ?? '', /адрес/);
  publishCentral('0.2.18', 20, { versionCode: 'x' });
  assert.equal((await androidMirrorCheck()).ok, false);
  assert.equal(local().version, '0.2.17');
});

test('файл пропал с тома — скачиваем заново даже без новой версии', async () => {
  publishCentral('0.2.17', 19);
  fs.rmSync(path.join(androidDir, 'novpn.apk'));
  const r = await androidMirrorCheck();
  assert.equal(r.action, 'mirrored', r.error);
  assert.ok(localApk().equals(central.apk));
});

test('центральная сама себя не зеркалит, выключенное зеркало — тоже', async () => {
  assert.equal((await androidMirrorCheck({ own: UPSTREAM })).action, 'self');
  assert.equal((await androidMirrorCheck({ upstream: '' })).action, 'off');
});
