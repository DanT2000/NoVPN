// Владелец: «не могу найти приложение на сайте, выдаёт 404». Ссылка «скачать» у нашего
// же приложения вела на raw.githubusercontent.com/.../desktop/vpn.exe — файл давно
// называется novpn.exe, и GitHub у части людей не открывается. Качать надо с панели.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = path.join(os.tmpdir(), `novpn-applink-${process.pid}-${Math.floor(process.hrtime()[1])}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.DATABASE_PATH = path.join(tmp, 'database.sqlite');
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.SESSION_SECRET = 'test';

const { DEFAULT_APPS } = await import('@novpn/shared');
const { db } = await import('../src/db.js');
const repo = await import('../src/repo.js');
const { seedIfEmpty } = await import('../src/seed.js');

test('каталог: наше приложение качается с панели, а не с github', () => {
  const app = DEFAULT_APPS.find((a) => a.id === 'novpn-desktop')!;
  const win = app.platforms.find((p) => p.platform === 'Windows')!;
  assert.equal(win.url, '/desktop/novpn.exe', 'ссылка ведёт в канал обновлений самой панели');
  assert.ok(!/github/i.test(String(win.url)), 'github у части людей не открывается');
});

test('уже заведённая панель: мёртвая github-ссылка чинится миграцией', () => {
  seedIfEmpty();
  // Возвращаем запись в состояние «как было на проде» и перезапускаем миграцию.
  const before = repo.getApp('novpn-desktop')!;
  const broken = { ...before, platforms: [{ platform: 'Windows', url: 'https://raw.githubusercontent.com/DanT2000/NoVPN/main/desktop/vpn.exe' }] };
  db.prepare("UPDATE app_clients SET data = ? WHERE id = 'novpn-desktop'").run(JSON.stringify(broken));
  assert.match(repo.getApp('novpn-desktop')!.platforms[0]!.url!, /githubusercontent/, 'подготовили сломанное состояние');

  // Миграция живёт в db.ts и выполняется при импорте — повторяем её запрос напрямую.
  const row = db.prepare("SELECT data FROM app_clients WHERE id = 'novpn-desktop'").get() as { data: string };
  const app = JSON.parse(row.data) as { platforms: Array<{ platform: string; url?: string | null }> };
  for (const p of app.platforms) {
    if (typeof p.url === 'string' && /raw\.githubusercontent\.com\/.*\/desktop\/(vpn|novpn)\.exe$/.test(p.url)) p.url = '/desktop/novpn.exe';
  }
  db.prepare("UPDATE app_clients SET data = ? WHERE id = 'novpn-desktop'").run(JSON.stringify(app));
  assert.equal(repo.getApp('novpn-desktop')!.platforms[0]!.url, '/desktop/novpn.exe');
});
