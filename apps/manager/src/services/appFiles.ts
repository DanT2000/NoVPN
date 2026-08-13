// Хранение файлов приложений (APK/EXE/AppImage) на диске (постоянный том appsDir),
// а НЕ в SQLite: инсталляторы бывают 60–120 МБ. Загрузка/отдача — СТРИМОМ, чтобы не
// держать весь файл в памяти (панель-сервер бывает на 1–2 ГБ RAM).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { config } from '../config.js';
import * as repo from '../repo.js';

// Серверный потолок размера файла (бэкстоп к клиентскому лимиту): чтобы прямой
// API-вызов не забил том, где лежит и база. 500 МБ — с запасом на крупные инсталляторы.
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

function ensureDir(): string {
  fs.mkdirSync(config.appsDir, { recursive: true });
  return config.appsDir;
}

// Без разделителей/переходов вверх: имя файла на диске полностью детерминировано
// и не выходит за appsDir (защита от path traversal).
const safe = (s: string): string => String(s).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
const diskName = (appId: string, platform: string, origName: string): string =>
  `${safe(appId)}__${safe(platform)}__${safe(origName) || 'file'}`;

const CT: Record<string, string> = {
  '.apk': 'application/vnd.android.package-archive',
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.appimage': 'application/x-executable',
  '.deb': 'application/vnd.debian.binary-package',
  '.dmg': 'application/x-apple-diskimage',
  '.zip': 'application/zip',
};

/** Стрим-загрузка файла приложения на диск. Пишем во ВРЕМЕННЫЙ файл и только по
 *  успешному завершению атомарно переименовываем поверх, а старый удаляем ПОСЛЕ —
 *  иначе оборванная замена уничтожила бы рабочий файл. Обрыв/ошибка/переполнение
 *  размера → чистим temp, промис отклоняется (без зависаний и утечки дескриптора). */
export function saveUpload(appId: string, platform: string, origName: string, req: Request): Promise<{ name: string; size: number }> {
  ensureDir();
  const full = path.join(config.appsDir, diskName(appId, platform, origName));
  // Temp с ПРЕФИКСОМ «.upload-» (не совпадает с «<app>__<platform>__») — чтобы
  // removeFiles на успехе его не задел; осиротевшие temp подберёт cleanupOrphans.
  const tmp = path.join(config.appsDir, `.upload-${crypto.randomBytes(8).toString('hex')}`);
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(tmp);
    let size = 0;
    let settled = false;
    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      req.unpipe(ws);
      ws.destroy();
      fs.rm(tmp, { force: true }, () => {});
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_UPLOAD_BYTES) {
        req.destroy();
        fail(new Error(`Файл больше ${Math.round(MAX_UPLOAD_BYTES / 1048576)} МБ.`));
      }
    });
    // Обрыв соединения клиентом эмитит 'aborted'/'close' (не 'error') — ловим оба.
    req.on('aborted', () => fail(new Error('Загрузка прервана.')));
    req.on('error', fail);
    ws.on('error', fail);
    ws.on('finish', () => {
      if (settled) return;
      settled = true;
      try {
        removeFiles(appId, platform); // старые версии убираем только теперь, когда новый файл на диске
        fs.renameSync(tmp, full);
        resolve({ name: origName, size });
      } catch (e) {
        fs.rm(tmp, { force: true }, () => {});
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    req.pipe(ws);
  });
}

/** Путь к файлу на диске по (appId, platform, оригинальное имя). null, если нет. */
export function filePath(appId: string, platform: string, origName: string): string | null {
  const full = path.join(config.appsDir, diskName(appId, platform, origName));
  return fs.existsSync(full) ? full : null;
}

/** Отдать файл клиенту стримом (Content-Disposition = оригинальное имя). */
export function streamDownload(res: Response, full: string, origName: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(full); // файл мог исчезнуть между проверкой и отдачей (TOCTOU)
  } catch {
    if (!res.headersSent) res.status(404).send('');
    return;
  }
  const ext = path.extname(origName).toLowerCase();
  res.setHeader('Content-Type', CT[ext] ?? 'application/octet-stream');
  res.setHeader('Content-Length', String(stat.size));
  // ASCII-имя в filename + RFC5987 filename* для кириллицы/пробелов.
  res.setHeader('Content-Disposition', `attachment; filename="${origName.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(origName)}`);
  const rs = fs.createReadStream(full);
  rs.on('error', () => {
    if (!res.headersSent) res.status(500).send('');
    res.destroy();
  });
  rs.pipe(res);
}

/** Удалить файл конкретной (app, platform) — ТОЧНО по имени из каталога, а не по
 *  префиксу: префикс «<app>__<platform>__» неоднозначен (app «a__b»/platform «c» даёт
 *  то же имя, что app «a»/platform «b»), и удалил бы чужой файл. Осиротевшие подберёт
 *  cleanupOrphans. */
export function removeFiles(appId: string, platform: string): void {
  const entry = repo.getApp(appId)?.platforms.find((p) => p.platform === platform);
  if (!entry?.downloadName) return;
  try {
    fs.rmSync(path.join(config.appsDir, diskName(appId, platform, entry.downloadName)), { force: true });
  } catch {
    /* нет файла — нечего чистить */
  }
}

/** Удалить осиротевшие файлы: те, на которые больше нет ссылок в каталоге. */
export function cleanupOrphans(): number {
  ensureDir();
  const keep = new Set(repo.allDownloadRefs().map((r) => diskName(r.appId, r.platform, r.name)));
  let removed = 0;
  try {
    for (const f of fs.readdirSync(config.appsDir))
      if (!keep.has(f)) {
        fs.rmSync(path.join(config.appsDir, f), { force: true });
        removed += 1;
      }
  } catch {
    /* нет каталога */
  }
  return removed;
}
