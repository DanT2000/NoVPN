// Умная маршрутизация: зеркалирование внешних JSON-источников.
// Раз в час проверяем файлы в режиме mirror+autoSync. Перед публикацией — полная
// защита (last-known-good): HTTP ok, непустой ответ, валидный JSON, корневой тип
// совпадает с рабочим, нет подозрительного сжатия. Условный GET (ETag/Last-Modified)
// экономит трафик. Та же логика обслуживает ручную кнопку «Проверить сейчас»
// (apply=false → ничего не публикует, только возвращает превью).

import * as repo from '../repo.js';
import type { RoutingCheckResult, RoutingFileName } from '@novpn/shared';
import { analyzeShape, diffCounts, normalizeJson } from '../lib/routingJson.js';

// Отклоняем автообновление, если число элементов упало ниже этой доли прежнего
// (защита от обрезанного/битого источника: 12483 → 317). Работает только когда
// count определим у обеих версий и прежняя была осмысленно большой.
const SHRINK_REJECT_RATIO = 0.5;
const SHRINK_MIN_BASE = 10;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_BYTES = 8 * 1024 * 1024;

let running = false;

// Дебаунс ошибок фонового зеркала (как в sync.ts): не чаще раза в 30 мин на файл.
const lastErrAt = new Map<string, number>();
function logErr(name: string, msg: string): void {
  const now = Date.now();
  if (now - (lastErrAt.get(name) ?? 0) < 30 * 60 * 1000) return;
  lastErrAt.set(name, now);
  repo.addJobError('Маршрутизация', `${name}.json: ${msg}`, 'warn');
}

interface Fetched {
  status: number;
  text: string;
  etag: string | null;
  lastModified: string | null;
  notModified: boolean;
}

async function fetchSource(url: string, etag: string | null, lastModified: string | null): Promise<Fetched> {
  const headers: Record<string, string> = { Accept: 'application/json, text/plain, */*' };
  if (etag) headers['If-None-Match'] = etag;
  if (lastModified) headers['If-Modified-Since'] = lastModified;
  const res = await fetch(url, { method: 'GET', headers, redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (res.status === 304) return { status: 304, text: '', etag, lastModified, notModified: true };
  const text = await res.text();
  return {
    status: res.status,
    text,
    etag: res.headers.get('etag'),
    lastModified: res.headers.get('last-modified'),
    notModified: false,
  };
}

/**
 * Проверить внешний источник файла и (если apply) применить безопасное обновление.
 * apply=true  — авто-режим: при прохождении всех проверок публикует новую версию.
 * apply=false — ручная кнопка: НЕ публикует; при изменении возвращает content для
 *               «Открыть в редакторе». В ручном режиме etag/last_modified НЕ пишем,
 *               чтобы авто-синк потом не получил 304 и не пропустил обновление.
 */
export async function checkMirror(name: RoutingFileName, opts: { apply: boolean }): Promise<RoutingCheckResult> {
  const row = repo.getRoutingRow(name);
  if (!row) return miss('Неизвестный файл.');
  const url = String(row.source_url ?? '').trim();
  if (!url) return miss('Не задан URL источника.');

  const now = repo.nowIso();
  const persist = opts.apply; // только авто-режим ведёт conditional-GET состояние

  let fetched: Fetched;
  try {
    fetched = await fetchSource(url, row.etag ?? null, row.last_modified ?? null);
  } catch (e) {
    const reason = e instanceof Error ? e.message : 'ошибка запроса';
    repo.updateRoutingSyncState(name, { lastCheckAt: now, status: 'error', statusReason: `Ошибка запроса: ${reason}` });
    logErr(name, reason);
    return { ok: false, changed: false, status: 'error', reason: `Ошибка запроса: ${reason}`, count: row.entry_count ?? null, added: null, removed: null };
  }

  // 304 Not Modified — источник подтвердил: без изменений.
  if (fetched.notModified) {
    repo.updateRoutingSyncState(name, { lastCheckAt: now, status: 'nochange', statusReason: '' });
    return { ok: true, changed: false, status: 'nochange', reason: 'Обновлений нет (304).', count: row.entry_count ?? null, added: null, removed: null };
  }
  // HTTP статус
  if (fetched.status < 200 || fetched.status >= 300) {
    const reason = `HTTP ${fetched.status}`;
    repo.updateRoutingSyncState(name, { lastCheckAt: now, status: 'error', statusReason: reason });
    logErr(name, reason);
    return { ok: false, changed: false, status: 'error', reason, count: null, added: null, removed: null };
  }
  const text = fetched.text ?? '';
  // непустой ответ
  if (!text.trim()) {
    const reason = 'Пустой ответ от источника';
    repo.updateRoutingSyncState(name, { lastCheckAt: now, status: 'error', statusReason: reason });
    logErr(name, reason);
    return { ok: false, changed: false, status: 'error', reason, count: null, added: null, removed: null };
  }
  // размер
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) {
    const reason = 'Ответ больше 8 МБ';
    repo.updateRoutingSyncState(name, { lastCheckAt: now, status: 'error', statusReason: reason });
    logErr(name, reason);
    return { ok: false, changed: false, status: 'error', reason, count: null, added: null, removed: null };
  }
  // валидный JSON
  try {
    JSON.parse(text);
  } catch {
    const reason = 'Ответ не является валидным JSON';
    repo.updateRoutingSyncState(name, { lastCheckAt: now, status: 'error', statusReason: reason });
    logErr(name, reason);
    return { ok: false, changed: false, status: 'error', reason, count: null, added: null, removed: null };
  }

  const oldShape = analyzeShape(String(row.content ?? ''));
  const newShape = analyzeShape(text);

  // корневой тип должен совпадать с текущей рабочей версией (если та определена)
  if (oldShape.rootType !== 'other' && newShape.rootType !== oldShape.rootType) {
    const reason = `Структура изменилась: было «${oldShape.rootType}», стало «${newShape.rootType}»`;
    repo.updateRoutingSyncState(name, { lastCheckAt: now, status: 'rejected', statusReason: reason });
    logErr(name, `отклонено — ${reason}`);
    return { ok: false, changed: false, status: 'rejected', reason, count: newShape.count, added: null, removed: null };
  }

  const changed = normalizeJson(text) !== normalizeJson(String(row.content ?? ''));
  const { added, removed } = diffCounts(oldShape.entries, newShape.entries);

  // содержимое не изменилось — версию не трогаем
  if (!changed) {
    repo.updateRoutingSyncState(name, {
      lastCheckAt: now,
      status: 'nochange',
      statusReason: '',
      ...(persist ? { etag: fetched.etag, lastModified: fetched.lastModified } : {}),
    });
    return { ok: true, changed: false, status: 'nochange', reason: 'Содержимое не изменилось.', count: newShape.count, added: 0, removed: 0 };
  }

  // защита от подозрительного сжатия (обрезанный/битый источник)
  if (
    oldShape.count != null &&
    newShape.count != null &&
    oldShape.count >= SHRINK_MIN_BASE &&
    newShape.count < oldShape.count * SHRINK_REJECT_RATIO
  ) {
    const reason = `количество элементов уменьшилось с ${oldShape.count} до ${newShape.count}`;
    repo.updateRoutingSyncState(name, { lastCheckAt: now, status: 'rejected', statusReason: `Обновление отклонено проверкой: ${reason}` });
    logErr(name, `отклонено — ${reason}`);
    return { ok: false, changed: false, status: 'rejected', reason, count: newShape.count, added, removed };
  }

  // все проверки пройдены
  if (opts.apply) {
    repo.applyRoutingMirror(name, text, {
      etag: fetched.etag,
      lastModified: fetched.lastModified,
      added,
      removed,
      rootType: newShape.rootType,
      count: newShape.count,
    });
    lastErrAt.delete(name);
    repo.addLog(`Умная маршрутизация: ${name}.json обновлён из источника (+${added ?? 0}/−${removed ?? 0})`);
    return { ok: true, changed: true, status: 'ok', reason: 'Обновлено из источника.', count: newShape.count, added, removed };
  }

  // ручная проверка: только отмечаем факт проверки, контент отдаём для редактора
  repo.updateRoutingSyncState(name, { lastCheckAt: now, status: 'ok', statusReason: 'Найдены изменения (не применены).' });
  return { ok: true, changed: true, status: 'ok', reason: 'Найдены изменения.', count: newShape.count, added, removed, content: text };
}

function miss(reason: string): RoutingCheckResult {
  return { ok: false, changed: false, status: 'error', reason, count: null, added: null, removed: null };
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (const t of repo.listRoutingSyncTargets()) {
      try {
        await checkMirror(t.name, { apply: true });
      } catch (e) {
        logErr(t.name, e instanceof Error ? e.message : 'ошибка');
      }
    }
  } finally {
    running = false;
  }
}

export function startRoutingSyncLoop(intervalMs = 3_600_000): void {
  const t = setInterval(() => void tick(), intervalMs);
  t.unref?.();
  // первый прогон вскоре после старта (не сразу — даём панели подняться)
  setTimeout(() => void tick(), 15_000).unref?.();
}
