// «Скачать» у NoVPN для Android на любой панели. 26.11.2026: у Роберта в карточке была только
// «Добавить подписку» — кнопка появлялась лишь при файле, загруженном вручную в админке.
// Теперь по умолчанию ссылка на канал /android/novpn.apk: своя панель отдаёт файл сама,
// панель без своего канала перенаправляет на центральную (1.7.3) — обновил у себя, обновилось
// у всех. Файл или своя ссылка, заданные вручную, важнее.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { AppClient } from '@novpn/shared';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'novpn-apklink-'));
process.env.DATABASE_PATH = path.join(tmp, 'database.sqlite');
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.SESSION_SECRET = 'test-secret';

const { reviseCatalogAndroidLink, isOwnFileUrl, NOVPN_APK, DEFAULT_APPS } = await import('@novpn/shared');
const { seedIfEmpty } = await import('../src/seed.js');
const { db, getSetting, setSetting } = await import('../src/db.js');
const { renderSubPage } = await import('../src/services/subPage.js');

const app = (id: string, platforms: AppClient['platforms']): AppClient =>
  ({ id, client: id, compat: ['xray'], source: '', instruction: '', enabled: true, platforms }) as unknown as AppClient;

test('ссылка на свой файл панели распознаётся, чужие и кривые — нет', () => {
  assert.equal(NOVPN_APK, '/android/novpn.apk');
  for (const u of ['/android/novpn.apk', '/desktop/novpn.exe', ' /android/novpn.apk ']) assert.equal(isOwnFileUrl(u), true, u);
  for (const u of [null, undefined, '', 'https://vpn.appswire.ru/android/novpn.apk', '/android/', '/android/../x.apk', '//evil.example/a.apk', '/guide/x'])
    assert.equal(isOwnFileUrl(u as string), false, String(u));
});

test('каталог по умолчанию: у NoVPN для Android есть ссылка на канал', () => {
  const e = DEFAULT_APPS.find((a) => a.id === 'novpn-android')!.platforms.find((p) => p.platform === 'Android')!;
  assert.equal(e.url, NOVPN_APK);
});

test('ревизия: пустая ссылка → канал; своя ссылка и загруженный файл не трогаются', () => {
  const r = reviseCatalogAndroidLink([app('novpn-android', [{ platform: 'Android' }]), app('happ', [{ platform: 'Android' }])]);
  assert.equal(r[0]!.platforms[0]!.url, NOVPN_APK);
  assert.equal(r[1]!.platforms[0]!.url, undefined, 'чужие приложения не трогаем');
  const custom = reviseCatalogAndroidLink([app('novpn-android', [{ platform: 'Android', url: 'https://example.org/my.apk' }])]);
  assert.equal(custom[0]!.platforms[0]!.url, 'https://example.org/my.apk');
  const withFile = reviseCatalogAndroidLink([app('novpn-android', [{ platform: 'Android', downloadName: 'novpn-android.apk', downloadSize: 5 }])]);
  assert.equal(withFile[0]!.platforms[0]!.downloadName, 'novpn-android.apk');
});

test('существующая панель без ссылки (как у Роберта) получает её один раз', () => {
  seedIfEmpty();
  assert.equal(getSetting<number>('catalog_rev', 0), 2, 'новая панель сразу в новой редакции');
  // Состояние панели Роберта: ревизия 1, у NoVPN для Android нет ни файла, ни ссылки.
  const row = db.prepare("SELECT data FROM app_clients WHERE id = 'novpn-android'").get() as { data: string };
  const a = JSON.parse(row.data) as AppClient;
  a.platforms = [{ platform: 'Android' }];
  db.prepare("UPDATE app_clients SET data = ? WHERE id = 'novpn-android'").run(JSON.stringify(a));
  setSetting('catalog_rev', 1);
  seedIfEmpty();
  const after = JSON.parse((db.prepare("SELECT data FROM app_clients WHERE id = 'novpn-android'").get() as { data: string }).data) as AppClient;
  assert.equal(after.platforms[0]!.url, NOVPN_APK);
  assert.equal(getSetting<number>('catalog_rev', 0), 2);
  // Админ стёр ссылку осознанно — повторный запуск её не возвращает.
  after.platforms = [{ platform: 'Android' }];
  db.prepare("UPDATE app_clients SET data = ? WHERE id = 'novpn-android'").run(JSON.stringify(after));
  seedIfEmpty();
  const again = JSON.parse((db.prepare("SELECT data FROM app_clients WHERE id = 'novpn-android'").get() as { data: string }).data) as AppClient;
  assert.equal(again.platforms[0]!.url, undefined);
});

const page = (platforms: AppClient['platforms']) =>
  renderSubPage({
    appName: 'NoVPN',
    user: { name: 'Тест', expiresAt: null, trafficUsedGb: 1 } as any,
    subUrl: 'https://vpn.example/sub/abc',
    configCount: 1,
    whitelist: false,
    apps: [{ ...app('novpn-android', platforms), client: 'NoVPN для Android', urlScheme: 'novpn://subscribe?url=' } as AppClient],
  });
const androidCard = (html: string) => html.slice(html.indexOf('data-plat="Android"'));

test('страница подписки: ссылка на канал — это «Скачать», а не «Установить»', () => {
  const card = androidCard(page([{ platform: 'Android', url: NOVPN_APK }]));
  assert.match(card, /href="\/android\/novpn\.apk"[^>]*>⬇ Скачать</);
  assert.doesNotMatch(card, />Установить</);
  assert.match(card, /Добавить подписку/);
});

test('страница подписки: файл из админки + ссылка на канал — одна кнопка «Скачать» (файл)', () => {
  const card = androidCard(page([{ platform: 'Android', url: NOVPN_APK, downloadName: 'novpn-android.apk', downloadSize: 5 }]));
  assert.equal((card.match(/⬇ Скачать/g) || []).length, 1);
  assert.match(card, /href="\/apps\/file\/novpn-android\/Android"/);
  assert.doesNotMatch(card, />Установить</);
});
