// Канал обновлений NoVPN Desktop: проверка подписи Ed25519, валидация zip-релиза
// (5 критериев), режимы (auto/pin/manual), сравнение версий. Данные — реальный релиз
// из desktop/ репозитория (novpn.exe + подписанный latest.json).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';

const tmp = path.join(os.tmpdir(), `novpn-desk-${process.pid}-${Math.floor(process.hrtime()[1])}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.DATABASE_PATH = path.join(tmp, 'database.sqlite');
process.env.DESKTOP_DIR = path.join(tmp, 'desktop');
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.SESSION_SECRET = 'test';

const REPO_DESKTOP = fileURLToPath(new URL('../../../desktop', import.meta.url));
const dc = await import('../src/services/desktopChannel.js');

const manifest = JSON.parse(fs.readFileSync(path.join(REPO_DESKTOP, 'latest.json'), 'utf8'));
const exe = fs.readFileSync(path.join(REPO_DESKTOP, 'novpn.exe'));

test('verifySignature: валидна на реальном релизе; ломается при подмене байта', () => {
  assert.equal(dc.verifySignature(exe, manifest.signature), true);
  const tampered = Buffer.from(exe);
  tampered[100] = tampered[100] ^ 0xff;
  assert.equal(dc.verifySignature(tampered, manifest.signature), false);
});

function makeZip(man: unknown, bin: Buffer): Buffer {
  const z = new AdmZip();
  z.addFile('latest.json', Buffer.from(JSON.stringify(man)));
  z.addFile('novpn.exe', bin);
  return z.toBuffer();
}

test('validateZip: валидный релиз проходит все 5 проверок', () => {
  const r = dc.validateZip(makeZip(manifest, exe));
  assert.equal(r.ok, true);
  assert.equal(r.manifest?.version, manifest.version);
  assert.equal(r.exe?.length, manifest.sizeBytes);
});

test('validateZip: отклоняет неверный sha256', () => {
  const bad = { ...manifest, sha256: 'deadbeef'.repeat(8) };
  const r = dc.validateZip(makeZip(bad, exe));
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /sha256/i);
});

test('validateZip: отклоняет неверный размер', () => {
  const bad = { ...manifest, sizeBytes: manifest.sizeBytes + 1 };
  const r = dc.validateZip(makeZip(bad, exe));
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /азмер/);
});

test('validateZip: отклоняет битую подпись', () => {
  const bad = { ...manifest, signature: 'AAAA' + (manifest.signature as string).slice(4) };
  const r = dc.validateZip(makeZip(bad, exe));
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /одпись/);
});

test('validateZip: требует наличие обоих файлов', () => {
  const z = new AdmZip();
  z.addFile('latest.json', Buffer.from(JSON.stringify(manifest)));
  const r = dc.validateZip(z.toBuffer());
  assert.equal(r.ok, false);
});

test('config: по умолчанию auto; pin round-trip', () => {
  assert.equal(dc.getDesktopConfig().mode, 'auto');
  dc.setDesktopConfig({ mode: 'pin', pinnedVersion: '0.2.5' });
  assert.deepEqual(dc.getDesktopConfig(), { mode: 'pin', pinnedVersion: '0.2.5' });
  dc.setDesktopConfig({ mode: 'auto' });
  assert.equal(dc.getDesktopConfig().mode, 'auto');
});

test('verCmp: числовое сравнение (0.10.0 > 0.9.0)', () => {
  assert.equal(dc.verCmp('0.10.0', '0.9.0'), 1);
  assert.equal(dc.verCmp('0.2.5', '0.2.5'), 0);
  assert.equal(dc.verCmp('1.0.0', '0.99.99'), 1);
});

test('publish + listVersions + currentManifest', () => {
  dc.publish(manifest, exe);
  assert.equal(dc.currentManifest()?.version, manifest.version);
  const vs = dc.listVersions();
  assert.ok(vs.some((v) => v.version === manifest.version));
});

// Инцидент 28.08.2026: релиз 0.2.6 лежал в репозитории, а панель продолжала отдавать
// 0.2.5. С прод-хоста GitHub недоступен напрямую (та же причина, по которой источники
// AutoRoute ходят через ghfast.top), выборка падала на следующий источник — а это САМА
// панель: она читала собственную старую версию и молча отвечала «изменений нет».
test('источники зеркала: рабочее зеркало GitHub впереди, своя панель — последней', () => {
  const src = dc.CENTRAL_SOURCES;
  assert.ok(src.length >= 2);
  assert.match(src[0]!, /ghfast\.top/, 'первым — зеркало, доступное с прод-хоста');
  assert.ok(
    src.every((s) => s.endsWith('/desktop')),
    'каждый источник — база, к которой дописывается /latest.json и /novpn.exe',
  );
  const own = src.findIndex((s) => s.includes('vpn.appswire.ru'));
  assert.equal(own, src.length - 1, 'собственная панель — только последний запасной вариант');
});
