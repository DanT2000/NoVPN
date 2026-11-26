// Параметры маскировки AmneziaWG: что пишем на сервер и откуда берём при переустановке.
// 26.11.2026: «Франция 1» — H1=1 на сервере при 2012218649 в панели (граница проверки была
// 2 000 000 000), а 30.08 переустановка взяла параметры из устаревшей копии панели и
// сломала все выданные конфиги.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = path.join(os.tmpdir(), `novpn-awgp-${process.pid}-${Math.floor(process.hrtime()[1])}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.DATABASE_PATH = path.join(tmp, 'database.sqlite');
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.SESSION_SECRET = 'test-secret';

const { checkAwgParams, pickAwgParams, buildInstallScript, genAwgParams } = await import('../src/services/sshServer.js');

const A = { Jc: 4, Jmin: 40, Jmax: 70, S1: 86, S2: 97, H1: 1004746675, H2: 928473625, H3: 1719083348, H4: 1339303396 };
const B = { Jc: 4, Jmin: 9, Jmax: 48, S1: 23, S2: 94, H1: 2012218649, H2: 1501317059, H3: 1076010440, H4: 1064530999 };

test('H больше 2 млрд уходит на сервер как есть, а не превращается в «без маскировки»', () => {
  assert.deepEqual(checkAwgParams(B), B);
  const sh = buildInstallScript({ sni: 'www.lenovo.com', realityPriv: 'x', shortId: 'ab', awgPriv: 'y', xray: false, awg: true, awgParams: B, xrayPort: 443, awgPort: 443 });
  assert.match(sh, /H1=2012218649;/);
  assert.doesNotMatch(sh, /H1=1;/);
});

test('параметр вне границ — ошибка, а не тихая подмена', () => {
  assert.throws(() => checkAwgParams({ ...B, H1: 4294967296 }), /H1=4294967296/);
  assert.throws(() => checkAwgParams({ ...B, Jc: -1 }), /Jc/);
  assert.throws(() => checkAwgParams({ ...B, S1: 'x' as unknown as number }), /S1/);
  assert.throws(() => checkAwgParams({ ...B, H2: '1; rm -rf /' as unknown as number }), /H2/);
});

test('генератор всегда проходит проверку и не даёт H из типов WireGuard', () => {
  for (let i = 0; i < 2000; i++) {
    const p = genAwgParams();
    assert.deepEqual(checkAwgParams(p), p);
    for (const k of ['H1', 'H2', 'H3', 'H4'] as const) assert.ok(p[k] > 4, `${k}=${p[k]}`);
  }
});

test('переустановка: решает то, что на руках у людей, а не копия в панели', () => {
  const fresh = () => { throw new Error('новые параметры здесь не нужны'); };
  // 30.08: на сервере и у людей A, в копии панели B — раньше брали B и ломали всех.
  let r = pickAwgParams({ onServer: A, stored: B, issued: A, fresh });
  assert.deepEqual(r.params, A);
  assert.equal(r.source, 'server');
  assert.equal(r.storedDiffers, true);
  // Новая машина (на сервере пусто), копия совпадает с людьми — берём копию.
  r = pickAwgParams({ onServer: null, stored: A, issued: A, fresh });
  assert.deepEqual(r.params, A);
  assert.equal(r.source, 'stored');
  assert.equal(r.storedDiffers, false);
  // Новая машина со старым чужим awg0.conf, копия пустая — берём параметры из конфигов людей.
  r = pickAwgParams({ onServer: B, stored: null, issued: A, fresh });
  assert.deepEqual(r.params, A);
  assert.equal(r.source, 'issued');
  // Конфигов нет — то, что стоит на сервере; потом копия; потом новые.
  assert.equal(pickAwgParams({ onServer: B, stored: A, issued: null, fresh }).source, 'server');
  assert.equal(pickAwgParams({ onServer: null, stored: A, issued: null, fresh }).source, 'stored');
  const made = pickAwgParams({ onServer: null, stored: null, issued: null, fresh: () => B });
  assert.equal(made.source, 'new');
  assert.deepEqual(made.params, B);
});
