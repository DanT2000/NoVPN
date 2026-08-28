// Канал раздачи и обновления NoVPN Desktop.
// - Раздача /desktop/* с ПОСТОЯННОГО тома (config.desktopDir=/data/desktop); при первом
//   старте сидим из встроенной в образ версии (config.desktopSeedDir).
// - Загрузка релиза разработчиком: zip {latest.json, novpn.exe} → 5 проверок (наличие,
//   размер, sha256, подпись Ed25519, [версия новее]) → публикация + архив.
// - Авто-зеркало: раз в час тянем с центрального источника (GitHub raw → резерв
//   vpn.appswire.ru), качаем ТОЛЬКО при смене версии, проверяем sha256+подпись, кладём к себе.
// - Режимы панели: auto (последняя) | pin (закреплённая из архива) | manual (только загрузка).
// Приватного ключа на сервере НЕТ — сервер только ПРОВЕРЯЕТ публичным ключом.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { config } from '../config.js';
import { getSetting, setSetting } from '../db.js';
import * as repo from '../repo.js';

const PUBKEY_B64 = 'mAKrDKVxw35ZXElNCksRYgzEmzESGvfXMx5Zbc2oCUw=';
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex'); // DER-префикс SPKI ed25519
// Порядок важен. С прод-хоста панели GitHub напрямую НЕДОСТУПЕН (та же причина, по
// которой источники AutoRoute ходят через ghfast.top), поэтому зеркало GitHub стоит
// первым — иначе выборка падала на второй источник, а это САМА панель: она читала
// собственную старую версию и «обновление» никогда не приезжало (0.2.6 висела в
// репозитории, а панель отдавала 0.2.5).
export const CENTRAL_SOURCES = [
  'https://ghfast.top/https://raw.githubusercontent.com/DanT2000/NoVPN/main/desktop',
  'https://raw.githubusercontent.com/DanT2000/NoVPN/main/desktop',
  'https://vpn.appswire.ru/desktop',
];
const MAX_EXE = 200 * 1024 * 1024;
const EXE_NAME = 'novpn.exe';
const FETCH_TIMEOUT_MS = 60_000;

export type DesktopMode = 'auto' | 'pin' | 'manual';
export interface DesktopChannelConfig {
  mode: DesktopMode;
  pinnedVersion: string | null;
}

export function getDesktopConfig(): DesktopChannelConfig {
  const c = getSetting<DesktopChannelConfig>('desktop_channel', { mode: 'auto', pinnedVersion: null });
  return { mode: c.mode === 'pin' || c.mode === 'manual' ? c.mode : 'auto', pinnedVersion: c.pinnedVersion ?? null };
}
export function setDesktopConfig(patch: Partial<DesktopChannelConfig>): DesktopChannelConfig {
  const cur = getDesktopConfig();
  const next: DesktopChannelConfig = {
    mode: patch.mode ?? cur.mode,
    pinnedVersion: patch.pinnedVersion !== undefined ? patch.pinnedVersion : cur.pinnedVersion,
  };
  setSetting('desktop_channel', next);
  return next;
}

// ── подпись Ed25519 (raw 32-байтный публичный ключ → SPKI DER) ──
function pubKey(): crypto.KeyObject {
  const der = Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(PUBKEY_B64, 'base64')]);
  return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
}
export function verifySignature(data: Buffer, sigB64: string): boolean {
  try {
    return crypto.verify(null, data, pubKey(), Buffer.from(sigB64, 'base64'));
  } catch {
    return false;
  }
}

export interface Manifest {
  version: string;
  url?: string;
  sha256: string;
  signature: string;
  sizeBytes: number;
  [k: string]: unknown;
}

// ── диск ──
const releasesDir = (): string => path.join(config.desktopDir, 'releases');

function writeAtomic(file: string, data: Buffer | string): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}
function copyDir(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

/** Первичный сид /data/desktop из встроенной версии образа (если ещё пусто). */
export function seedDesktopDir(): void {
  try {
    if (fs.existsSync(path.join(config.desktopDir, 'latest.json'))) return; // уже засеяно
    if (!config.desktopSeedDir || !fs.existsSync(config.desktopSeedDir)) return;
    copyDir(config.desktopSeedDir, config.desktopDir);
    console.log('[desktop] /data/desktop засеян встроенной версией из образа');
  } catch (e) {
    console.error('[desktop] сид не удался:', e instanceof Error ? e.message : e);
  }
}

export function currentManifest(): Manifest | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(config.desktopDir, 'latest.json'), 'utf8')) as Manifest;
  } catch {
    return null;
  }
}

/** Версии в локальном архиве releases/ (latest-X.Y.Z.json + novpn-X.Y.Z.exe). */
export function listVersions(): Array<{ version: string; sizeBytes: number; notes?: string }> {
  try {
    const out: Array<{ version: string; sizeBytes: number; notes?: string }> = [];
    for (const f of fs.readdirSync(releasesDir())) {
      const m = /^latest-(.+)\.json$/.exec(f);
      if (!m) continue;
      try {
        const man = JSON.parse(fs.readFileSync(path.join(releasesDir(), f), 'utf8')) as Manifest;
        if (fs.existsSync(path.join(releasesDir(), `novpn-${man.version}.exe`))) {
          out.push({ version: man.version, sizeBytes: man.sizeBytes, notes: typeof man.notes === 'string' ? man.notes : undefined });
        }
      } catch {
        /* пропускаем битый */
      }
    }
    return out.sort((a, b) => verCmp(b.version, a.version));
  } catch {
    return [];
  }
}

function verInt(v: string): number[] {
  return String(v).split('.').map((x) => parseInt(x, 10) || 0);
}
export function verCmp(a: string, b: string): number {
  const A = verInt(a);
  const B = verInt(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const d = (A[i] ?? 0) - (B[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Опубликовать релиз в раздачу + архив. url переписываем на СВОЙ домен, чтобы трафик
 *  скачиваний шёл к этому провайдеру, а не к разработчику (sha256/подпись — над байтами,
 *  url не подписан, поэтому переписывать безопасно). */
export function publish(manifest: Manifest, exe: Buffer): void {
  fs.mkdirSync(releasesDir(), { recursive: true });
  const own = repo.publicBaseUrl();
  const served: Manifest = { ...manifest, url: own ? `${own}/desktop/${EXE_NAME}` : manifest.url };
  // архив (оригинальный манифест — чтобы pin/re-publish воспроизводили ровно исходное)
  writeAtomic(path.join(releasesDir(), `novpn-${manifest.version}.exe`), exe);
  writeAtomic(path.join(releasesDir(), `latest-${manifest.version}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  // текущая раздача
  writeAtomic(path.join(config.desktopDir, EXE_NAME), exe);
  writeAtomic(path.join(config.desktopDir, 'latest.json'), `${JSON.stringify(served, null, 2)}\n`);
  repo.addLog(`NoVPN Desktop: опубликована версия ${manifest.version}`);
}

function publishFromArchive(version: string): boolean {
  const exeP = path.join(releasesDir(), `novpn-${version}.exe`);
  const manP = path.join(releasesDir(), `latest-${version}.json`);
  if (!fs.existsSync(exeP) || !fs.existsSync(manP)) return false;
  publish(JSON.parse(fs.readFileSync(manP, 'utf8')) as Manifest, fs.readFileSync(exeP));
  return true;
}

// ── загрузка релиза (zip) ──
export interface ValidateResult {
  ok: boolean;
  manifest?: Manifest;
  exe?: Buffer;
  error?: string;
}
export function validateZip(zipBuf: Buffer): ValidateResult {
  let zip: AdmZip;
  try {
    zip = new AdmZip(zipBuf);
  } catch {
    return { ok: false, error: 'Не удалось прочитать zip-архив.' };
  }
  const manEntry = zip.getEntry('latest.json');
  const exeEntry = zip.getEntry(EXE_NAME) ?? zip.getEntry('vpn.exe');
  if (!manEntry || !exeEntry) return { ok: false, error: 'В архиве должны быть latest.json и novpn.exe.' };
  let manifest: Manifest;
  try {
    manifest = JSON.parse(manEntry.getData().toString('utf8')) as Manifest;
  } catch {
    return { ok: false, error: 'latest.json — не валидный JSON.' };
  }
  const exe = exeEntry.getData();
  if (exe.length > MAX_EXE) return { ok: false, error: 'Установщик больше 200 МБ.' };
  if (!manifest.version || !/^\d+(\.\d+)*$/.test(String(manifest.version))) return { ok: false, error: 'Некорректная version в манифесте.' };
  if (exe.length !== manifest.sizeBytes) return { ok: false, error: `Размер не совпал: файл ${exe.length}, манифест ${manifest.sizeBytes}.` };
  if (crypto.createHash('sha256').update(exe).digest('hex') !== manifest.sha256) return { ok: false, error: 'sha256 не совпал с манифестом.' };
  if (!manifest.signature || !verifySignature(exe, manifest.signature)) return { ok: false, error: 'Подпись Ed25519 не прошла проверку.' };
  return { ok: true, manifest, exe };
}

/** Принять загруженный релиз (уже провалидированный) и опубликовать. */
export function acceptUpload(zipBuf: Buffer): { ok: boolean; version?: string; error?: string } {
  const v = validateZip(zipBuf);
  if (!v.ok || !v.manifest || !v.exe) return { ok: false, error: v.error };
  publish(v.manifest, v.exe);
  return { ok: true, version: v.manifest.version };
}

// ── авто-зеркало ──
async function fetchCentral(suffix: string): Promise<Buffer> {
  let lastErr: unknown;
  for (const base of CENTRAL_SOURCES) {
    try {
      const res = await fetch(base + suffix, { redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error('источник недоступен');
}

let mirrorRunning = false;
export async function mirrorCheck(opts: { force?: boolean } = {}): Promise<{ ok: boolean; action: string; version?: string; error?: string }> {
  const { mode, pinnedVersion } = getDesktopConfig();
  if (mode === 'manual') return { ok: true, action: 'manual' };
  if (mode === 'pin') {
    if (!pinnedVersion) return { ok: false, action: 'pin', error: 'Версия для закрепления не выбрана.' };
    if (currentManifest()?.version === pinnedVersion && !opts.force) return { ok: true, action: 'nochange', version: pinnedVersion };
    if (publishFromArchive(pinnedVersion)) return { ok: true, action: 'pinned', version: pinnedVersion };
    return { ok: false, action: 'pin', error: `Версия ${pinnedVersion} не найдена в локальном архиве (поработайте в режиме «Авто», чтобы она скачалась).` };
  }
  // auto: только ПОВЫШАЕМ версию (никогда не откатываем — иначе панель разработчика
  // с только что залитой новой версией «откатилась» бы до версии из GitHub).
  try {
    const manifest = JSON.parse((await fetchCentral('/latest.json')).toString('utf8')) as Manifest;
    const cur = currentManifest()?.version;
    if (cur && verCmp(manifest.version, cur) < 0) return { ok: true, action: 'nochange', version: cur }; // не откатываем НИКОГДА
    if (cur === manifest.version && !opts.force) return { ok: true, action: 'nochange', version: cur };
    const exe = await fetchCentral(`/${EXE_NAME}`).catch(() => fetchCentral('/vpn.exe')); // совместимость со старым именем
    if (exe.length !== manifest.sizeBytes) return { ok: false, action: 'auto', error: 'размер установщика не совпал с манифестом' };
    if (crypto.createHash('sha256').update(exe).digest('hex') !== manifest.sha256) return { ok: false, action: 'auto', error: 'sha256 не совпал' };
    if (!verifySignature(exe, manifest.signature)) return { ok: false, action: 'auto', error: 'подпись Ed25519 невалидна' };
    publish(manifest, exe);
    return { ok: true, action: 'mirrored', version: manifest.version };
  } catch (e) {
    return { ok: false, action: 'auto', error: e instanceof Error ? e.message : 'ошибка' };
  }
}

async function tick(): Promise<void> {
  if (mirrorRunning) return;
  mirrorRunning = true;
  try {
    const r = await mirrorCheck();
    if (!r.ok && r.error) repo.addJobError('Desktop', `Зеркало обновлений: ${r.error}`, 'warn');
  } catch {
    /* фон не должен ронять процесс */
  } finally {
    mirrorRunning = false;
  }
}
export function startDesktopMirrorLoop(intervalMs = 3_600_000): void {
  const t = setInterval(() => void tick(), intervalMs);
  t.unref?.();
  setTimeout(() => void tick(), 20_000).unref?.();
}
