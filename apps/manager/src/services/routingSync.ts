// Умная маршрутизация: зеркалирование внешних JSON-источников.
// Раз в час проверяем файлы в режиме mirror+autoSync. Источник может быть в форматах
// .json (как есть), .lst/.txt (построчный список → JSON {items}) или .srs (бинарный
// sing-box rule-set → decompile → source JSON). Формат определяется по расширению URL;
// после конвертации в канонический JSON работает ЕДИНЫЙ конвейер защиты:
// непустой → валидный JSON → корневой тип совпадает → нет резкого сжатия → last-known-good.
// Условный GET (ETag/Last-Modified) экономит трафик. Та же логика обслуживает ручную
// кнопку «Проверить сейчас» (apply=false → ничего не публикует, только превью).

import * as repo from '../repo.js';
import type { RoutingCheckResult, RoutingFileName, RoutingSourceStats } from '@novpn/shared';
import { analyzeShape, diffCounts, normalizeJson } from '../lib/routingJson.js';
import { convertList, detectSourceFormat } from '../lib/routingConvert.js';
import { decompileSrs, SingboxUnavailableError } from './singbox.js';

// Отклоняем автообновление, если число элементов упало ниже этой доли прежнего
// (защита от обрезанного/битого источника: 12483 → 317). Работает только когда
// count определим у обеих версий и прежняя была осмысленно большой.
const SHRINK_REJECT_RATIO = 0.5;
const SHRINK_MIN_BASE = 10;
const SHRINK_MIN_BYTES = 2048; // байтовую защиту включаем только для осмысленно больших файлов
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

export interface Fetched {
  status: number;
  body: Buffer;
  etag: string | null;
  lastModified: string | null;
  notModified: boolean;
  tooLarge?: boolean;
}

export const ROUTING_MAX_BYTES = MAX_BYTES;

export async function fetchSource(url: string, etag: string | null, lastModified: string | null): Promise<Fetched> {
  const headers: Record<string, string> = { Accept: 'application/json, text/plain, application/octet-stream, */*' };
  if (etag) headers['If-None-Match'] = etag;
  if (lastModified) headers['If-Modified-Since'] = lastModified;
  const res = await fetch(url, { method: 'GET', headers, redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (res.status === 304) return { status: 304, body: Buffer.alloc(0), etag, lastModified, notModified: true };
  const etagOut = res.headers.get('etag');
  const lmOut = res.headers.get('last-modified');
  // Не буферизуем гигабайты в память: если сервер объявил размер больше лимита —
  // отменяем чтение тела сразу, не materialize'я весь ответ (защита от OOM на редиректе).
  const clen = Number(res.headers.get('content-length') || 0);
  if (Number.isFinite(clen) && clen > MAX_BYTES) {
    try {
      await res.body?.cancel();
    } catch {
      /* тело уже закрыто */
    }
    return { status: res.status, body: Buffer.alloc(0), etag: etagOut, lastModified: lmOut, notModified: false, tooLarge: true };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, body: buf, etag: etagOut, lastModified: lmOut, notModified: false };
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
  if (!row) return miss('Неизвестный файл.', { format: 'json' });
  const url = String(row.source_url ?? '').trim();
  if (!url) return miss('Не задан URL источника.', { format: 'json' });

  const format = detectSourceFormat(url);
  const baseStats: RoutingSourceStats = { format };
  const now = repo.nowIso();
  const persist = opts.apply; // только авто-режим ведёт conditional-GET состояние

  let fetched: Fetched;
  try {
    fetched = await fetchSource(url, row.etag ?? null, row.last_modified ?? null);
  } catch (e) {
    const reason = `Ошибка запроса: ${e instanceof Error ? e.message : 'сбой'}`;
    repo.updateRoutingSyncState(name, { lastCheckAt: now, status: 'error', statusReason: reason });
    logErr(name, reason);
    return { ok: false, changed: false, status: 'error', reason, count: row.entry_count ?? null, added: null, removed: null, stats: baseStats };
  }

  // 304 Not Modified — источник подтвердил: без изменений.
  if (fetched.notModified) {
    repo.updateRoutingSyncState(name, { lastCheckAt: now, status: 'nochange', statusReason: '' });
    return { ok: true, changed: false, status: 'nochange', reason: 'Обновлений нет (304).', count: row.entry_count ?? null, added: null, removed: null, stats: baseStats };
  }
  // HTTP статус
  if (fetched.status < 200 || fetched.status >= 300) {
    const reason = `HTTP ${fetched.status}`;
    repo.updateRoutingSyncState(name, { lastCheckAt: now, status: 'error', statusReason: reason });
    logErr(name, reason);
    return { ok: false, changed: false, status: 'error', reason, count: null, added: null, removed: null, stats: baseStats };
  }
  // непустой ответ
  if (fetched.body.length === 0) {
    const reason = 'Пустой ответ от источника';
    repo.updateRoutingSyncState(name, { lastCheckAt: now, status: 'error', statusReason: reason });
    logErr(name, reason);
    return { ok: false, changed: false, status: 'error', reason, count: null, added: null, removed: null, stats: baseStats };
  }
  // размер сырого ответа (объявленный Content-Length ловим в fetchSource → tooLarge)
  if (fetched.tooLarge || fetched.body.length > MAX_BYTES) {
    const reason = 'Ответ больше 8 МБ';
    repo.updateRoutingSyncState(name, { lastCheckAt: now, status: 'error', statusReason: reason });
    logErr(name, reason);
    return { ok: false, changed: false, status: 'error', reason, count: null, added: null, removed: null, stats: baseStats };
  }

  // ── конвертация формата → канонический JSON-текст + статистика ──
  let text: string;
  let stats: RoutingSourceStats;
  try {
    if (format === 'srs') {
      text = await decompileSrs(fetched.body); // source rule-set JSON (version+rules), без потерь
      stats = { format };
    } else if (format === 'lst' || format === 'txt') {
      const conv = convertList(fetched.body.toString('utf8'));
      text = JSON.stringify({ items: conv.items }, null, 2);
      stats = { format, lines: conv.lines, valid: conv.valid, skipped: conv.skipped, dups: conv.dups };
    } else {
      text = fetched.body.toString('utf8');
      stats = { format };
    }
  } catch (e) {
    const reason =
      e instanceof SingboxUnavailableError
        ? 'Формат SRS не может быть обработан: sing-box binary не найден'
        : `Ошибка конвертации источника: ${e instanceof Error ? e.message : 'сбой'}`;
    repo.updateRoutingSyncState(name, { lastCheckAt: now, status: 'error', statusReason: reason });
    logErr(name, reason);
    return { ok: false, changed: false, status: 'error', reason, count: null, added: null, removed: null, stats: baseStats };
  }

  // валидный JSON (для list/srs гарантировано, для json — проверка)
  try {
    JSON.parse(text);
  } catch {
    const reason = 'Ответ не является валидным JSON';
    repo.updateRoutingSyncState(name, { lastCheckAt: now, status: 'error', statusReason: reason });
    logErr(name, reason);
    return { ok: false, changed: false, status: 'error', reason, count: null, added: null, removed: null, stats };
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) {
    const reason = 'Результат больше 8 МБ';
    repo.updateRoutingSyncState(name, { lastCheckAt: now, status: 'error', statusReason: reason });
    logErr(name, reason);
    return { ok: false, changed: false, status: 'error', reason, count: null, added: null, removed: null, stats };
  }

  const oldShape = analyzeShape(String(row.content ?? ''));
  const newShape = analyzeShape(text);

  // корневой тип должен совпадать с текущей рабочей версией — но ТОЛЬКО если в ней уже
  // есть данные. Пустой файл (сид {"items":[]} или []) не защищаем: первый синк
  // устанавливает тип (иначе источник с массивом на верхнем уровне навсегда отклонялся
  // бы «object → array» и никогда не синкался).
  const oldEmpty = oldShape.count == null || oldShape.count === 0;
  if (!oldEmpty && oldShape.rootType !== 'other' && newShape.rootType !== oldShape.rootType) {
    const reason = `Структура изменилась: было «${oldShape.rootType}», стало «${newShape.rootType}»`;
    repo.updateRoutingSyncState(name, { lastCheckAt: now, status: 'rejected', statusReason: reason });
    logErr(name, `отклонено — ${reason}`);
    return { ok: false, changed: false, status: 'rejected', reason, count: newShape.count, added: null, removed: null, stats };
  }

  const changed = normalizeJson(text) !== normalizeJson(String(row.content ?? ''));
  const { added, removed } = diffCounts(oldShape.entries, newShape.entries);

  // содержимое не изменилось — версию не трогаем
  if (!changed) {
    repo.updateRoutingSyncState(name, {
      lastCheckAt: now,
      status: 'nochange',
      statusReason: '',
      // не обнуляем валидаторы, если ответ их не прислал (undefined = сохранить прежние)
      ...(persist ? { etag: fetched.etag ?? undefined, lastModified: fetched.lastModified ?? undefined } : {}),
    });
    return { ok: true, changed: false, status: 'nochange', reason: 'Содержимое не изменилось.', count: newShape.count, added: 0, removed: 0, stats };
  }

  // Защита от подозрительного сжатия (обрезанный/битый источник) — по количеству
  // элементов И по размеру в байтах. Байтовая проверка ловит .srs/rule-set, где
  // count≈1 (тысячи доменов спрятаны внутри одного правила), но обрезка резко роняет объём.
  const oldBytes = Buffer.byteLength(String(row.content ?? ''), 'utf8');
  const newBytes = Buffer.byteLength(text, 'utf8');
  const shrinkByCount =
    oldShape.count != null && newShape.count != null && oldShape.count >= SHRINK_MIN_BASE && newShape.count < oldShape.count * SHRINK_REJECT_RATIO;
  const shrinkByBytes = oldBytes >= SHRINK_MIN_BYTES && newBytes < oldBytes * SHRINK_REJECT_RATIO;
  if (shrinkByCount || shrinkByBytes) {
    const reason = shrinkByCount
      ? `количество элементов уменьшилось с ${oldShape.count} до ${newShape.count}`
      : `размер данных резко уменьшился (${Math.round(oldBytes / 1024)}КБ → ${Math.round(newBytes / 1024)}КБ)`;
    repo.updateRoutingSyncState(name, { lastCheckAt: now, status: 'rejected', statusReason: `Обновление отклонено проверкой: ${reason}` });
    logErr(name, `отклонено — ${reason}`);
    return { ok: false, changed: false, status: 'rejected', reason, count: newShape.count, added, removed, stats };
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
      stats,
    });
    lastErrAt.delete(name);
    repo.addLog(`Умная маршрутизация: ${name}.json обновлён из источника (${format.toUpperCase()}, +${added ?? 0}/−${removed ?? 0})`);
    return { ok: true, changed: true, status: 'ok', reason: 'Обновлено из источника.', count: newShape.count, added, removed, stats };
  }

  // ручная проверка: только отмечаем факт проверки, контент отдаём для редактора
  repo.updateRoutingSyncState(name, { lastCheckAt: now, status: 'ok', statusReason: 'Найдены изменения (не применены).' });
  return { ok: true, changed: true, status: 'ok', reason: 'Найдены изменения.', count: newShape.count, added, removed, stats, content: text };
}

function miss(reason: string, stats: RoutingSourceStats): RoutingCheckResult {
  return { ok: false, changed: false, status: 'error', reason, count: null, added: null, removed: null, stats };
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
