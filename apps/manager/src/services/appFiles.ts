// Хранение файлов приложений (APK/EXE/AppImage) на диске (постоянный том appsDir),
// а НЕ в SQLite: инсталляторы бывают 60–120 МБ. Загрузка/отдача — СТРИМОМ, чтобы не
// держать весь файл в памяти (панель-сервер бывает на 1–2 ГБ RAM).

import fs from 'node:fs';
import path from 'node:path';
import type { Request, Response } from 'express';
import { config } from '../config.js';
import * as repo from '../repo.js';

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

/** Стрим-загрузка файла приложения на диск. Возвращает имя (оригинальное) и размер. */
export function saveUpload(appId: string, platform: string, origName: string, req: Request): Promise<{ name: string; size: number }> {
  ensureDir();
  // Удаляем прежние файлы этой (app, platform) — чтобы не копить старые версии.
  removeFiles(appId, platform);
  const fname = diskName(appId, platform, origName);
  const full = path.join(config.appsDir, fname);
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(full);
    let size = 0;
    req.on('data', (c: Buffer) => (size += c.length));
    req.on('error', reject);
    ws.on('error', reject);
    ws.on('finish', () => resolve({ name: origName, size }));
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
  const ext = path.extname(origName).toLowerCase();
  res.setHeader('Content-Type', CT[ext] ?? 'application/octet-stream');
  res.setHeader('Content-Length', String(fs.statSync(full).size));
  // ASCII-имя в filename + RFC5987 filename* для кириллицы/пробелов.
  res.setHeader('Content-Disposition', `attachment; filename="${origName.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(origName)}`);
  fs.createReadStream(full).pipe(res);
}

/** Удалить все файлы конкретной (app, platform). */
export function removeFiles(appId: string, platform: string): void {
  const prefix = `${safe(appId)}__${safe(platform)}__`;
  try {
    for (const f of fs.readdirSync(config.appsDir)) if (f.startsWith(prefix)) fs.rmSync(path.join(config.appsDir, f), { force: true });
  } catch {
    /* каталога ещё нет — нечего чистить */
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
