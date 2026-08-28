// AutoRoute: сборка Upstream из многих источников.
//
// Раньше Upstream был одним файлом, который либо правили руками, либо зеркалили с
// ОДНОГО URL. Теперь это скомпилированный датасет: N источников → нормализация в
// единые правила → слияние по приоритету (кто выше в списке, тот побеждает в
// конфликте) → версия с diff'ом и возможностью отката.
//
// Публичный /routing/upstream.json продолжает отдавать привычный {items:[...]},
// поэтому уже выданные клиенты ничего не замечают: меняется только то, ОТКУДА
// берётся содержимое.
//
// Устойчивость: у каждого источника хранится last-known-good набор правил. Если
// источник сейчас лежит — сборка использует его прошлый разбор, а не обедняет базу.

import crypto from 'node:crypto';
import * as repo from '../repo.js';
import type {
  AutoRouteBuildResult,
  AutoRouteBuildSource,
  AutoRouteConflict,
  AutoRouteState,
  RoutingAction,
  RoutingSourceFormat,
  RoutingSourceStats,
} from '@novpn/shared';
import { convertList, detectSourceFormat } from '../lib/routingConvert.js';
import { parseSource, ruleKey, type ParsedRule } from '../lib/routingRules.js';
import { decompileSrs, SingboxUnavailableError } from './singbox.js';
import { fetchSource, ROUTING_MAX_BYTES } from './routingSync.js';

export const DATASET = 'upstream';

// Потолок размера итоговой базы. Re:filter/Antifilter — это десятки тысяч доменов,
// несколько таких источников дают сотни тысяч. Держим осмысленный предел, а факт
// обрезки НЕ замалчиваем — он попадает в причину статуса и в журнал.
const MAX_RULES = 200_000;

/** Хранимое правило сборки: kind/value/action/источник. Короткие ключи — база с
 *  сотнями тысяч записей иначе раздувается втрое на одних именах полей. */
interface StoredRule {
  k: ParsedRule['kind'];
  v: string;
  a: RoutingAction;
  s: string;
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

/** Разрешить формат источника: 'auto' → по расширению URL. */
function resolveFormat(format: string, url: string): RoutingSourceFormat {
  if (format === 'json' || format === 'lst' || format === 'txt' || format === 'srs') return format;
  return detectSourceFormat(url);
}

/**
 * Скачать источник и разобрать в правила. Успех → пишем last-known-good и 'ok'.
 * Неуспех → только статус: кеш остаётся прежним, сборка им и воспользуется.
 */
export async function refreshSource(id: string): Promise<{ ok: boolean; reason: string; count: number | null }> {
  const row = repo.getAutoRouteSourceRow(id);
  if (!row) return { ok: false, reason: 'Источник не найден.', count: null };
  const url = String(row.url ?? '').trim();
  const now = repo.nowIso();
  if (!url) {
    repo.setAutoRouteSourceState(id, { lastCheckAt: now, status: 'error', statusReason: 'Не задан URL.' });
    return { ok: false, reason: 'Не задан URL.', count: null };
  }

  const format = resolveFormat(String(row.format ?? 'auto'), url);
  const fail = (reason: string) => {
    repo.setAutoRouteSourceState(id, { lastCheckAt: now, status: 'error', statusReason: reason, resolvedFormat: format });
    return { ok: false, reason, count: (row.cached_count as number | null) ?? null };
  };

  let fetched;
  try {
    fetched = await fetchSource(url, row.etag ?? null, row.last_modified ?? null);
  } catch (e) {
    return fail(`Ошибка запроса: ${e instanceof Error ? e.message : 'сбой'}`);
  }

  if (fetched.notModified) {
    repo.setAutoRouteSourceState(id, { lastCheckAt: now, status: 'nochange', statusReason: '', resolvedFormat: format });
    return { ok: true, reason: 'Без изменений (304).', count: (row.cached_count as number | null) ?? null };
  }
  if (fetched.status < 200 || fetched.status >= 300) return fail(`HTTP ${fetched.status}`);
  if (fetched.tooLarge || fetched.body.length > ROUTING_MAX_BYTES) return fail('Ответ больше 8 МБ');
  if (fetched.body.length === 0) return fail('Пустой ответ от источника');

  // Формат → текст, пригодный для разбора.
  let text: string;
  let asJson: boolean;
  let stats: RoutingSourceStats = { format };
  try {
    if (format === 'srs') {
      text = await decompileSrs(fetched.body);
      asJson = true;
    } else if (format === 'json') {
      text = fetched.body.toString('utf8');
      JSON.parse(text); // рано отбраковываем мусор — иначе получим 0 правил без внятной причины
      asJson = true;
    } else {
      const raw = fetched.body.toString('utf8');
      const conv = convertList(raw);
      stats = { format, lines: conv.lines, valid: conv.valid, skipped: conv.skipped, dups: conv.dups };
      text = raw;
      asJson = false;
    }
  } catch (e) {
    if (e instanceof SingboxUnavailableError) return fail('Формат SRS не обработан: sing-box binary не найден');
    if (e instanceof SyntaxError) return fail('Ответ не является валидным JSON');
    return fail(`Ошибка разбора: ${e instanceof Error ? e.message : 'сбой'}`);
  }

  const parsed = parseSource(text, asJson);
  if (parsed.rules.length === 0) return fail('Источник не дал ни одного правила');

  // Защита от обрезанного источника: если раньше было существенно больше — не
  // затираем кеш, а сигналим. Иначе битая выкладка вымывает половину базы.
  const prev = (row.cached_count as number | null) ?? null;
  if (prev != null && prev >= 100 && parsed.rules.length < prev * 0.5) {
    const reason = `Отклонено: правил стало ${parsed.rules.length} вместо ${prev}`;
    repo.setAutoRouteSourceState(id, { lastCheckAt: now, status: 'rejected', statusReason: reason, resolvedFormat: format });
    return { ok: false, reason, count: prev };
  }

  repo.setAutoRouteSourceState(id, {
    lastCheckAt: now,
    lastOkAt: now,
    status: 'ok',
    statusReason: '',
    etag: fetched.etag,
    lastModified: fetched.lastModified,
    resolvedFormat: format,
    stats: asJson ? { format } : stats,
    cached: JSON.stringify(parsed.rules),
    cachedCount: parsed.rules.length,
  });
  return { ok: true, reason: 'Обновлено.', count: parsed.rules.length };
}

/** Прочитать last-known-good правила источника. */
function cachedRules(row: any): ParsedRule[] {
  if (!row?.cached) return [];
  try {
    const v = JSON.parse(String(row.cached));
    return Array.isArray(v) ? (v as ParsedRule[]) : [];
  } catch {
    return [];
  }
}

/** Публичное содержимое: {items:[...]}. Домены и CIDR — голыми (как отдавал
 *  прежний конвертер списков), остальные виды — с префиксом Xray. */
function toPublicItems(rules: StoredRule[]): string[] {
  return rules.map((r) => (r.k === 'domain' || r.k === 'ip' ? r.v : `${r.k}:${r.v}`));
}

/**
 * Пересобрать датасет из включённых источников.
 * Слияние: источники по возрастанию priority; первое встреченное значение
 * побеждает. Совпадение значения с ДРУГИМ действием — конфликт (побеждает
 * приоритетный, проигравшие перечисляются).
 */
export function buildDataset(dataset = DATASET): AutoRouteBuildResult {
  const sources = repo.listAutoRouteSources(dataset).filter((s) => s.enabled);
  if (!sources.length) {
    return { ok: false, reason: 'Нет включённых источников — собирать нечего.', build: null, conflicts: [] };
  }

  const winners = new Map<string, StoredRule>();
  const conflictsByKey = new Map<string, AutoRouteConflict>();
  const perSource = new Map<string, AutoRouteBuildSource>();
  let truncated = false;

  for (const s of sources) {
    const row = repo.getAutoRouteSourceRow(s.id);
    const rules = cachedRules(row);
    const entry: AutoRouteBuildSource = { sourceId: s.id, title: s.title, rules: rules.length, won: 0, conflicts: 0 };
    perSource.set(s.id, entry);
    for (const r of rules) {
      if (winners.size >= MAX_RULES) {
        truncated = true;
        break;
      }
      const key = ruleKey(r);
      const prev = winners.get(key);
      if (!prev) {
        winners.set(key, { k: r.kind, v: r.value, a: s.action, s: s.id });
        entry.won++;
        continue;
      }
      if (prev.a === s.action) continue; // тот же вердикт — просто дубль, не конфликт
      entry.conflicts++;
      const owner = perSource.get(prev.s);
      const c = conflictsByKey.get(key) ?? {
        kind: r.kind,
        value: r.value,
        winner: { sourceId: prev.s, title: owner?.title ?? prev.s, action: prev.a },
        losers: [],
      };
      c.losers.push({ sourceId: s.id, title: s.title, action: s.action });
      conflictsByKey.set(key, c);
    }
    if (truncated) break;
  }

  const merged = [...winners.values()];
  const domains = merged.filter((r) => r.k === 'domain' || r.k === 'full').length;
  const ips = merged.filter((r) => r.k === 'ip').length;

  // diff против опубликованной версии
  const publishedVersion = repo.getPublishedAutoRouteVersion(dataset);
  let prevKeys = new Set<string>();
  if (publishedVersion != null) {
    const raw = repo.getAutoRouteBuildRules(dataset, publishedVersion);
    if (raw) {
      try {
        for (const r of JSON.parse(raw) as StoredRule[]) prevKeys.add(`${r.k}:${r.v}`);
      } catch {
        prevKeys = new Set();
      }
    }
  }
  const nowKeys = new Set(merged.map((r) => `${r.k}:${r.v}`));
  let added = 0;
  for (const k of nowKeys) if (!prevKeys.has(k)) added++;
  let removed = 0;
  for (const k of prevKeys) if (!nowKeys.has(k)) removed++;

  const rulesJson = JSON.stringify(merged);
  const build = repo.insertAutoRouteBuild(dataset, {
    sha256: sha256(rulesJson),
    domains,
    ips,
    added,
    removed,
    conflicts: conflictsByKey.size,
    sourcesChanged: sources.length,
    sources: [...perSource.values()],
    rules: rulesJson,
  });

  publishBuild(dataset, build.version, merged);

  const reason = truncated
    ? `Собрано ${merged.length} правил — достигнут потолок ${MAX_RULES}, часть источников не вошла целиком.`
    : `Собрано ${merged.length} правил из ${sources.length} источников.`;
  if (truncated) repo.addJobError('Маршрутизация', `AutoRoute: ${reason}`, 'warn');
  repo.addLog(`AutoRoute: собрана версия v${build.version} (+${added}/−${removed}, конфликтов ${conflictsByKey.size})`);

  return { ok: true, reason, build: { ...build, published: true }, conflicts: [...conflictsByKey.values()].slice(0, 200) };
}

/** Опубликовать версию: содержимое уезжает в routing_files.upstream, откуда его
 *  отдаёт публичный URL. Режим файла принудительно local — им теперь владеет
 *  AutoRoute, и старое зеркало не должно затирать результат сборки. */
function publishBuild(dataset: string, version: number, rules: StoredRule[]): void {
  const content = JSON.stringify({ items: toPublicItems(rules) }, null, 2);
  repo.saveRoutingContent(dataset, content);
  repo.saveRoutingSource(dataset, { mode: 'local' });
  repo.markAutoRouteBuildPublished(dataset, version);
}

/** Откатиться на сохранённую версию: публикуем её содержимое как есть. */
export function rollbackTo(dataset: string, version: number): { ok: boolean; reason: string } {
  const raw = repo.getAutoRouteBuildRules(dataset, version);
  if (!raw) return { ok: false, reason: 'Версия не найдена.' };
  let rules: StoredRule[];
  try {
    rules = JSON.parse(raw) as StoredRule[];
  } catch {
    return { ok: false, reason: 'Версия повреждена.' };
  }
  publishBuild(dataset, version, rules);
  repo.addLog(`AutoRoute: откат на версию v${version}`);
  return { ok: true, reason: `Опубликована версия v${version}.` };
}

export function getState(origin: string, dataset = DATASET): AutoRouteState {
  return {
    dataset,
    sources: repo.listAutoRouteSources(dataset),
    builds: repo.listAutoRouteBuilds(dataset),
    publishedVersion: repo.getPublishedAutoRouteVersion(dataset),
    publicUrl: `${origin}/routing/${dataset}.json`,
  };
}

/** Обновить все включённые источники и пересобрать. Используется кнопкой
 *  «Проверить и пересобрать» и часовым автосинком. */
export async function refreshAllAndBuild(dataset = DATASET): Promise<AutoRouteBuildResult> {
  const sources = repo.listAutoRouteSources(dataset).filter((s) => s.enabled);
  for (const s of sources) {
    try {
      await refreshSource(s.id);
    } catch (e) {
      repo.setAutoRouteSourceState(s.id, {
        lastCheckAt: repo.nowIso(),
        status: 'error',
        statusReason: e instanceof Error ? e.message : 'сбой',
      });
    }
  }
  return buildDataset(dataset);
}
