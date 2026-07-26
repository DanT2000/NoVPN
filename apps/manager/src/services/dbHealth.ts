// Самотест изоляции базы: переживёт ли она переустановку/редеплой.
//
// Опасность: приложение в контейнере, а данные лежат на ОДНОРАЗОВОМ томе
// (анонимный docker volume от «VOLUME [/data]»), который редеплой/пересоздание
// контейнера выбрасывает — и все пользователи теряются. Просто проверить «это
// отдельное монтирование» нельзя: из-за VOLUME в Dockerfile /data всегда
// смонтировано, но анонимный том от постоянного так не отличить.
//
// Честный сигнал персистентности — ПЕРЕЖИВАНИЕ ПЕРЕСОЗДАНИЯ КОНТЕЙНЕРА:
//  • в каталоге базы копим набор id контейнеров (hostname меняется на каждый
//    редеплой). Если в маркере ≥2 разных id — том пережил пересоздание →
//    постоянный. На одноразовом томе набор всегда сбрасывается (всегда 1 id).
//  • плюс: если в базе уже есть данные СТАРШЕ текущего процесса — том тоже
//    очевидно постоянный (данные пришли из прошлой жизни контейнера). Это
//    снимает тревогу с уже работающих установок (прод) на первом же запуске.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DbHealth } from '@novpn/shared';
import { config } from '../config.js';

const PROC_START = Date.now();
const CONFIRM_MARGIN_MS = 5 * 60 * 1000; // данные старше процесса на 5+ минут

function inContainer(): boolean {
  if (fs.existsSync('/.dockerenv')) return true;
  try {
    return /docker|containerd|kubepods|lxc/.test(fs.readFileSync('/proc/1/cgroup', 'utf8'));
  } catch {
    return false;
  }
}

/** Записать текущий id контейнера в маркер каталога базы, вернуть число
 *  различных id, которые этот том успел повидать. */
function distinctContainerIds(dbDir: string): number {
  const f = path.join(dbDir, '.novpn-persistence');
  let ids: string[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(f, 'utf8')) as { ids?: unknown };
    if (Array.isArray(parsed.ids)) ids = parsed.ids.filter((x): x is string => typeof x === 'string');
  } catch {
    /* маркера ещё нет или он битый */
  }
  const myId = os.hostname() || 'unknown';
  if (!ids.includes(myId)) ids.push(myId);
  if (ids.length > 10) ids = ids.slice(-10);
  try {
    fs.writeFileSync(f, JSON.stringify({ ids }));
  } catch {
    /* каталог только для чтения — не критично */
  }
  return ids.length;
}

/**
 * @param earliestDataIso — время самой ранней записи в базе (created_at) или null.
 */
export function checkDbIsolation(earliestDataIso: string | null): DbHealth {
  const dbPath = config.databasePath;
  const dbDir = path.dirname(dbPath);
  const container = inContainer();

  const seenIds = distinctContainerIds(dbDir);
  const hasPriorData =
    !!earliestDataIso && new Date(earliestDataIso).getTime() < PROC_START - CONFIRM_MARGIN_MS;
  const confirmedPersistent = seenIds >= 2 || hasPriorData;

  // Тревога только в контейнере и только пока персистентность не подтверждена.
  // На «голом» сервере (не контейнер) редеплой базу не трогает — не пугаем.
  const risky = container && !confirmedPersistent;
  return { dbPath, container, confirmedPersistent, risky };
}
