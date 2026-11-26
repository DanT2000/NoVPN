// Ревизия каталога 26.11.2026: живые ссылки Happ/v2rayNG, пометка «нет в российском App
// Store», лишние клиенты выключены, NoVPN первым; инструкция /guide/ios-region.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server as HttpServer } from 'node:http';
import type { AppClient } from '@novpn/shared';

const tmp = path.join(os.tmpdir(), `novpn-catrev-${process.pid}-${Math.floor(process.hrtime()[1])}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.DATABASE_PATH = path.join(tmp, 'database.sqlite');
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.SESSION_SECRET = 'test-secret';

const { reviseCatalog2026_11, orderApps } = await import('@novpn/shared');
const { seedIfEmpty } = await import('../src/seed.js');
const { db, getSetting } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');

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

const app = (id: string, platforms: AppClient['platforms'], enabled = true): AppClient =>
  ({ id, client: id, compat: ['xray'], source: '', instruction: '', enabled, platforms }) as unknown as AppClient;

test('ревизия: ссылки, пометка, выключенные клиенты, NoVPN первым, загруженные файлы целы', () => {
  const old = [
    app('happ', [
      { platform: 'Android', url: 'https://play.google.com/store/apps/details?id=com.happproxy', downloadName: 'happ.apk', downloadSize: 10 },
      { platform: 'iOS', url: 'https://apps.apple.com/ru/app/happ-proxy-utility-plus/id6746188973' },
      { platform: 'Windows', url: 'https://github.com/Happ-proxy/happ-desktop/releases/latest' },
    ]),
    app('v2rayng', [{ platform: 'Android', url: 'https://play.google.com/store/apps/details?id=com.v2ray.ang' }]),
    app('amneziawg', [{ platform: 'iOS', url: 'https://apps.apple.com/app/amneziawg/id6478942365' }]),
    app('streisand', [{ platform: 'iOS', url: 'x' }]),
    app('novpn-desktop', [{ platform: 'Windows', url: '/desktop/novpn.exe' }]),
    app('novpn-android', [{ platform: 'Android' }]),
  ];
  const r = reviseCatalog2026_11(old);
  assert.deepEqual(r.map((a) => a.id), ['novpn-desktop', 'novpn-android', 'happ', 'v2rayng', 'amneziawg', 'streisand']);
  const happ = r.find((a) => a.id === 'happ')!;
  const android = happ.platforms.find((p) => p.platform === 'Android')!;
  assert.match(android.url!, /github\.com\/Happ-proxy\/happ-android/);
  assert.equal(android.downloadName, 'happ.apk', 'файл, загруженный админом, не трогаем');
  const ios = happ.platforms.find((p) => p.platform === 'iOS')!;
  assert.equal(ios.regionNote, true);
  assert.doesNotMatch(ios.url!, /\/ru\//);
  assert.equal(r.find((a) => a.id === 'v2rayng')!.enabled, false);
  assert.equal(r.find((a) => a.id === 'streisand')!.enabled, false);
  assert.equal(r.find((a) => a.id === 'amneziawg')!.enabled, true);
  assert.match(r.find((a) => a.id === 'v2rayng')!.platforms[0]!.url!, /github\.com\/2dust\/v2rayNG/);
  // Исходник не испорчен (ревизия работает на копии).
  assert.match(old[0]!.platforms[0]!.url!, /play\.google/);
  assert.deepEqual(orderApps([{ id: 'x' }, { id: 'happ' }, { id: 'novpn-android' }]).map((a) => a.id), ['novpn-android', 'happ', 'x']);
});

test('новая панель: каталог сразу в новой редакции, NoVPN первым, ревизия не повторяется', () => {
  seedIfEmpty();
  assert.equal(getSetting<number>('catalog_rev', 0), 1);
  const ids = (db.prepare('SELECT id FROM app_clients ORDER BY sort ASC').all() as Array<{ id: string }>).map((r) => r.id);
  assert.ok(ids[0]!.startsWith('novpn-') && ids[1]!.startsWith('novpn-'), ids.join(','));
  assert.equal(ids[2], 'happ');
});

test('инструкция «Happ из России» открывается', async () => {
  const r = await fetch(`${base}/guide/ios-region`);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /<title>[^<]*Happ на iPhone/);
  assert.match(html, /Медиаматериалы и покупки/);
  assert.match(html, /support\.apple\.com\/ru-ru\/118283/);
});
