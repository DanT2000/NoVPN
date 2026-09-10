// Страница подписки (/sub/<token>): порядок приложений и вложенная инструкция NoVPN.
// Владелец просил: NoVPN Desktop первым, Happ вторым, у Happ ссылка на сайт, а
// инструкция — прямо в карточке, а не только отдельной страницей.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = path.join(os.tmpdir(), `novpn-subpage-${process.pid}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.DATABASE_PATH = path.join(tmp, 'database.sqlite');
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.SESSION_SECRET = 'test-secret';

const { renderSubPage } = await import('../src/services/subPage.js');

const app = (id: string, client: string, platforms: Array<{ platform: string; url: string }>, extra: Record<string, unknown> = {}) =>
  ({ id, client, compat: ['xray'], source: '', instruction: '', enabled: true, urlScheme: null, icon: null, platforms, ...extra }) as any;

const html = renderSubPage({
  appName: 'NoVPN',
  user: { name: 'Тест', expiresAt: null, trafficUsedGb: 1 } as any,
  subUrl: 'https://vpn.example/sub/abc',
  configCount: 2,
  whitelist: true,
  apps: [
    app('v2raytun', 'V2RayTun', [{ platform: 'Windows', url: 'https://v2raytun.com/' }], { source: 'https://v2raytun.com' }),
    app('happ', 'Happ', [{ platform: 'iOS', url: 'https://apps.apple.com/x' }, { platform: 'Windows', url: 'https://github.com/x' }], { source: 'https://happ.su', urlScheme: 'happ://add/' }),
    app('novpn-desktop', 'NoVPN Desktop', [{ platform: 'Windows', url: '/desktop/novpn.exe' }], { source: 'https://github.com/DanT2000/NoVPN', urlScheme: 'novpn://subscribe?url=' }),
  ],
});
const section = (plat: string) => {
  const start = html.indexOf(`data-plat="${plat}"`);
  const end = html.indexOf('<section class="plat"', start + 1);
  return html.slice(start, end > 0 ? end : undefined);
};
const names = (s: string) => [...s.matchAll(/app-n">([^<]+)</g)].map((m) => m[1]);

test('Windows: NoVPN Desktop → Happ → остальные', () => {
  assert.deepEqual(names(section('Windows')), ['NoVPN Desktop', 'Happ', 'V2RayTun']);
});

test('инструкция «Как установить» — только в карточке NoVPN, со SmartScreen и «Добавить подписку»', () => {
  const win = section('Windows');
  assert.equal((win.match(/Как установить — 4 шага/g) ?? []).length, 1);
  const card = win.slice(win.indexOf('NoVPN Desktop'), win.indexOf('app-n">Happ'));
  assert.ok(card.includes('SmartScreen'));
  assert.ok(card.includes('Добавить подписку'));
  assert.ok(card.includes('href="/guide/novpn-desktop"'));
});

test('у Happ есть ссылка на сайт, у NoVPN — нет', () => {
  const ios = section('iOS');
  assert.ok(ios.includes('href="https://happ.su"') && ios.includes('>Сайт<'));
  const win = section('Windows');
  const novpnCard = win.slice(win.indexOf('NoVPN Desktop'), win.indexOf('app-n">Happ'));
  assert.ok(!novpnCard.includes('>Сайт<'));
});
