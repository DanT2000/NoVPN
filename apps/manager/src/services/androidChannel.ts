// Зеркало канала NoVPN для Android (26.11.2026).
// Канал /android — это latest.json + novpn.apk на томе панели. У центральной панели
// (vpn.appswire.ru) его наполняет скрипт публикации. Панель без своих выпусков (у Роберта)
// раз в час сверяет версию с центральной (ANDROID_UPSTREAM) и, когда там новее, скачивает
// APK к себе: размер и sha256 из манифеста (и подпись Ed25519 тем же ключом, что у
// десктопа, если она есть в манифесте), только повышение versionCode, атомарная замена —
// сначала APK, потом latest.json. Пока своего канала нет, /android/* перенаправляется на
// центральную (app.ts).
// Итог: «Скачать» и обновления приложения у её людей идут с её же панели, ссылкой на неё
// можно делиться, а выпуск на центральной доезжает до всех панелей за час.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import * as repo from '../repo.js';
import { verifySignature } from './desktopChannel.js';

const APK = 'novpn.apk';
const MAX_APK = 200 * 1024 * 1024;
const MANIFEST_TIMEOUT_MS = 30_000;
const APK_TIMEOUT_MS = 10 * 60_000;

interface AndroidManifest {
  version: string;
  versionCode: number;
  url?: string;
  sha256: string;
  sizeBytes: number;
  signature?: string;
  [k: string]: unknown;
}

export interface AndroidMirrorResult {
  ok: boolean;
  /** off — выключено; self — это сама центральная; nochange — уже последняя; mirrored — скачали. */
  action: 'off' | 'self' | 'nochange' | 'mirrored' | 'error';
  version?: string;
  error?: string;
}

function manifestError(m: unknown): string | null {
  if (!m || typeof m !== 'object') return 'манифест — не объект';
  const x = m as Record<string, unknown>;
  if (typeof x.version !== 'string' || !/^\d+(\.\d+)*$/.test(x.version)) return 'в манифесте некорректная version';
  if (!Number.isInteger(x.versionCode) || (x.versionCode as number) <= 0) return 'в манифесте некорректный versionCode';
  if (typeof x.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(x.sha256)) return 'в манифесте некорректный sha256';
  if (!Number.isInteger(x.sizeBytes) || (x.sizeBytes as number) <= 0 || (x.sizeBytes as number) > MAX_APK) return 'в манифесте некорректный sizeBytes';
  if (x.url !== undefined && typeof x.url !== 'string') return 'в манифесте некорректный url';
  return null;
}

function readLocal(dir: string): AndroidManifest | null {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'latest.json'), 'utf8')) as AndroidManifest;
    return manifestError(m) ? null : m;
  } catch {
    return null;
  }
}

function writeAtomic(file: string, data: Buffer | string): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

const hostOf = (u: string): string | null => {
  try {
    return new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`).host.toLowerCase();
  } catch {
    return null;
  }
};

let running = false;

/** Одна сверка с центральной. Параметры — для тестов; по умолчанию из настроек панели. */
export async function androidMirrorCheck(
  opts: { upstream?: string; own?: string; dir?: string; force?: boolean } = {},
): Promise<AndroidMirrorResult> {
  const upstream = (opts.upstream ?? (config.androidMirror ? config.androidUpstream : '')).trim();
  if (!upstream) return { ok: true, action: 'off' };
  let origin: string;
  try {
    const u = new URL(upstream);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, action: 'error', error: 'адрес центральной панели — не http(s)' };
    origin = u.origin;
  } catch {
    return { ok: false, action: 'error', error: 'некорректный адрес центральной панели' };
  }
  // Центральная сама себя не зеркалит: её канал наполняет скрипт публикации.
  const own = opts.own ?? repo.publicBaseUrl();
  if (own && hostOf(own) === hostOf(origin)) return { ok: true, action: 'self' };

  const dir = opts.dir ?? config.androidDir;
  try {
    const res = await fetch(`${origin}/android/latest.json`, { redirect: 'follow', signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS) });
    if (!res.ok) return { ok: false, action: 'error', error: `манифест центральной: HTTP ${res.status}` };
    const m = (await res.json()) as AndroidManifest;
    const bad = manifestError(m);
    if (bad) return { ok: false, action: 'error', error: bad };

    const local = readLocal(dir);
    const apkPath = path.join(dir, APK);
    const apkOk = !!local && fs.existsSync(apkPath) && fs.statSync(apkPath).size === local.sizeBytes;
    // Только вперёд: панель с более новой версией (например, залитой вручную) не откатываем.
    if (local && m.versionCode < local.versionCode) return { ok: true, action: 'nochange', version: local.version };
    if (local && apkOk && m.versionCode === local.versionCode && !opts.force) return { ok: true, action: 'nochange', version: local.version };

    // Файл — только с той же центральной панели, что и манифест.
    const apkUrl = new URL(m.url || `/android/${APK}`, `${origin}/android/latest.json`);
    if (apkUrl.origin !== origin) return { ok: false, action: 'error', error: `адрес APK не на центральной панели: ${apkUrl.host}` };
    const ar = await fetch(apkUrl, { redirect: 'follow', signal: AbortSignal.timeout(APK_TIMEOUT_MS) });
    if (!ar.ok) return { ok: false, action: 'error', error: `APK с центральной: HTTP ${ar.status}` };
    const apk = Buffer.from(await ar.arrayBuffer());
    if (apk.length !== m.sizeBytes) return { ok: false, action: 'error', error: `размер APK ${apk.length} не совпал с манифестом (${m.sizeBytes})` };
    if (crypto.createHash('sha256').update(apk).digest('hex') !== m.sha256) return { ok: false, action: 'error', error: 'sha256 APK не совпал с манифестом' };
    if (m.signature !== undefined && !(typeof m.signature === 'string' && verifySignature(apk, m.signature)))
      return { ok: false, action: 'error', error: 'подпись Ed25519 APK невалидна' };

    fs.mkdirSync(dir, { recursive: true });
    writeAtomic(apkPath, apk);
    writeAtomic(path.join(dir, 'latest.json'), `${JSON.stringify({ ...m, url: `/android/${APK}` }, null, 2)}\n`);
    repo.addLog(`NoVPN для Android: с центральной панели скачана версия ${m.version}`);
    return { ok: true, action: 'mirrored', version: m.version };
  } catch (e) {
    return { ok: false, action: 'error', error: e instanceof Error ? e.message : 'ошибка' };
  }
}

// Предупреждение в журнал — не чаще раза в сутки на одну и ту же причину: центральная
// может быть недоступна часами, а сверка идёт каждый час.
let lastWarn = { text: '', at: 0 };
async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const r = await androidMirrorCheck();
    if (!r.ok && r.error && (r.error !== lastWarn.text || Date.now() - lastWarn.at > 86_400_000)) {
      lastWarn = { text: r.error, at: Date.now() };
      repo.addJobError('Android', `Зеркало канала Android: ${r.error}`, 'warn');
    }
  } catch {
    /* фон не должен ронять процесс */
  } finally {
    running = false;
  }
}

export function startAndroidMirrorLoop(intervalMs = 3_600_000): void {
  const t = setInterval(() => void tick(), intervalMs);
  t.unref?.();
  setTimeout(() => void tick(), 30_000).unref?.();
}
