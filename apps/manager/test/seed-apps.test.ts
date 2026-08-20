// NoVPN Desktop должен появляться в каталоге приложений и на новых панелях (пустой
// каталог), и на уже засеянных (миграция «добить недостающие дефолтные приложения»).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = path.join(os.tmpdir(), `novpn-seedapps-${process.pid}-${Math.floor(process.hrtime()[1])}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.DATABASE_PATH = path.join(tmp, 'database.sqlite');
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.SESSION_SECRET = 'test';

const repo = await import('../src/repo.js');
const { db } = await import('../src/db.js');
const { seedIfEmpty } = await import('../src/seed.js');

test('NoVPN Desktop есть после первичного сида (xray, Windows, ссылка на канал)', () => {
  seedIfEmpty();
  const d = repo.listApps().find((a) => a.id === 'novpn-desktop');
  assert.ok(d, 'novpn-desktop присутствует');
  assert.deepEqual(d!.compat, ['xray']);
  const win = d!.platforms.find((p) => p.platform === 'Windows');
  assert.match(win?.url ?? '', /desktop\/vpn\.exe/);
});

test('миграция добивает NoVPN Desktop в уже засеянный каталог', () => {
  db.prepare("DELETE FROM app_clients WHERE id = 'novpn-desktop'").run();
  assert.equal(repo.listApps().find((a) => a.id === 'novpn-desktop'), undefined);
  seedIfEmpty(); // каталог не пуст → должен добить недостающее
  assert.ok(repo.listApps().find((a) => a.id === 'novpn-desktop'), 'novpn-desktop добавлен в существующий каталог');
});
