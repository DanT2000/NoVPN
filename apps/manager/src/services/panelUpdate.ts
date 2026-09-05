// Обновление самой панели.
//
// Важное отличие от 3x-ui: тот живёт бинарником на хосте и умеет скачать новую версию
// с GitHub и подменить себя. Мы работаем как Docker-образ, который собирает CI из
// GitHub, поэтому «скачать и подменить себя внутри контейнера» бессмысленно — при
// следующем рестарте всё откатится к образу. Правильный аналог: панель СМОТРИТ, есть ли
// на GitHub версия новее, и по кнопке просит сборку пересобраться из свежего кода —
// дёргает настроенный админом хук деплоя. Дальше CI сам подтянет код и перезапустит
// контейнер, и панель поднимется уже новой.
//
// Обновление только РУЧНОЕ: человек нажимает сам, знает, что панель перезапустится.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as repo from '../repo.js';
import { verCmp } from './desktopChannel.js';

// Зеркало первым: с прод-хоста прямой github/raw перехватывается (см. desktopChannel).
const VERSION_SOURCES = [
  'https://ghfast.top/https://raw.githubusercontent.com/DanT2000/NoVPN/main/apps/manager/package.json',
  'https://raw.githubusercontent.com/DanT2000/NoVPN/main/apps/manager/package.json',
];

/** Версия работающей панели: package.json лежит в образе рядом с dist. */
export function currentVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // dist/services/panelUpdate.js → apps/manager/package.json
    const pkg = JSON.parse(fs.readFileSync(path.resolve(here, '../../package.json'), 'utf8')) as { version?: string };
    return String(pkg.version || '0.0.0');
  } catch {
    return '0.0.0';
  }
}

/** Версия на GitHub (ветка main). null — узнать не удалось (сеть/зеркало). */
async function fetchLatestVersion(): Promise<string | null> {
  for (const url of VERSION_SOURCES) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
      if (!r.ok) continue;
      const pkg = (await r.json()) as { version?: string };
      const v = String(pkg?.version || '').trim();
      if (v) return v;
    } catch {
      /* следующий источник */
    }
  }
  return null;
}

export interface PanelUpdateState {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  /** Настроен ли хук — без него кнопка «Обновить» работать не может. */
  hookConfigured: boolean;
  checkedAt: string;
  error?: string;
}

export async function checkUpdate(): Promise<PanelUpdateState> {
  const current = currentVersion();
  const latest = await fetchLatestVersion();
  const s = repo.getSettings();
  return {
    current,
    latest,
    updateAvailable: !!latest && verCmp(latest, current) > 0,
    hookConfigured: !!String(s.updateHookUrl ?? '').trim(),
    checkedAt: new Date().toISOString(),
    ...(latest ? {} : { error: 'Не удалось узнать версию на GitHub (нет связи или зеркало недоступно).' }),
  };
}

/** Запустить обновление: дёрнуть хук пересборки. Панель после этого перезапустится. */
export async function triggerUpdate(): Promise<{ ok: true; status: number }> {
  const s = repo.getSettings();
  const url = String(s.updateHookUrl ?? '').trim();
  if (!url) throw new Error('Хук обновления не настроен. Укажите его в настройках панели.');
  if (!/^https:\/\//i.test(url)) throw new Error('Хук обновления должен быть https-ссылкой.');
  const token = String(s.updateHookToken ?? '').trim();
  const send = (method: 'POST' | 'GET') =>
    fetch(url, {
      method,
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      signal: AbortSignal.timeout(20000),
    });
  // Обычные вебхуки принимают POST, а деплой Coolify отдаётся по GET. Пробуем POST и,
  // если метод не поддержан, повторяем GET — чтобы работало и там, и там.
  let r = await send('POST');
  if (r.status === 404 || r.status === 405) r = await send('GET');
  // 2xx — сборка принята. Тело не разбираем: у разных CI оно своё.
  if (!r.ok) throw new Error(`Хук ответил ${r.status}. Проверьте ссылку и токен.`);
  repo.addLog(`Запущено обновление панели (текущая версия ${currentVersion()})`);
  return { ok: true, status: r.status };
}
