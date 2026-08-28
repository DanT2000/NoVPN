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
  AutoRouteSearchHit,
  AutoRouteState,
  RoutingAction,
  RoutingSourceFormat,
  RoutingSourceStats,
} from '@novpn/shared';
import { convertList, detectSourceFormat } from '../lib/routingConvert.js';
import { encodeGeoIp, encodeGeoSite, GEO_TAG } from '../lib/geodat.js';
import { parseSource, ruleKey, type ParsedRule } from '../lib/routingRules.js';
import { BUILTIN_SOURCE_ID, BUILTIN_SOURCE_TITLE, builtinRules } from '../lib/builtinRoutes.js';
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

  // Встроенные правила — вне БД, с наивысшим приоритетом: побеждают в конфликтах и в
  // подписку попадают первыми (потолок их не срезает). В статистике сборки — отдельный
  // «источник», чтобы в AutoRoute было видно, откуда правило.
  const builtin = builtinRules();
  const builtinEntry: AutoRouteBuildSource = { sourceId: BUILTIN_SOURCE_ID, title: BUILTIN_SOURCE_TITLE, rules: builtin.length, won: 0, conflicts: 0 };
  perSource.set(BUILTIN_SOURCE_ID, builtinEntry);
  for (const r of builtin) {
    const key = ruleKey(r);
    if (winners.has(key)) continue;
    winners.set(key, { k: r.kind, v: r.value, a: 'vpn', s: BUILTIN_SOURCE_ID });
    builtinEntry.won++;
  }

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

  // Защита публикации. Пустая сборка (все источники недоступны и без кеша) или резко
  // похудевшая относительно опубликованной — НЕ публикуется: умный профиль с пустым
  // списком превращает VPN в «всё напрямую» у всех пользователей разом. Прод это
  // словил на первом же запуске: 4 источника, ни один не скачался, опубликовано 0.
  if (merged.length <= builtin.length) {
    const reason = 'Ни один источник не дал правил (только встроенные) — сборка не опубликована, прежняя версия остаётся.';
    repo.addJobError('Маршрутизация', `AutoRoute: ${reason}`, 'warn');
    return { ok: false, reason, build: null, conflicts: [] };
  }
  if (prevKeys.size >= 100 && merged.length < prevKeys.size * 0.5) {
    const reason = `Сборка похудела с ${prevKeys.size} до ${merged.length} правил — не опубликована, прежняя версия остаётся. Проверьте источники.`;
    repo.addJobError('Маршрутизация', `AutoRoute: ${reason}`, 'warn');
    return { ok: false, reason, build: null, conflicts: [...conflictsByKey.values()].slice(0, 200) };
  }

  const rulesJson = JSON.stringify(merged);
  // Сборка байт-в-байт совпала с опубликованной — новой версии не заводим. Иначе часовой
  // автосинк плодил бы версию в час на ровном месте: история сборок превращается в шум,
  // а клиенты по manifest'у видели бы «обновление» там, где ничего не изменилось.
  const publishedNow = repo.listAutoRouteBuilds(dataset).find((b) => b.published);
  if (publishedNow && publishedNow.sha256 === sha256(rulesJson)) {
    return { ok: true, reason: 'Изменений нет — версия прежняя.', build: publishedNow, conflicts: [...conflictsByKey.values()].slice(0, 200) };
  }
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
  // Кеши правил/DAT привязаны к версии; сбрасываем, чтобы подписка и DAT сразу
  // отдавали новую сборку, а не дожидались следующего сравнения версий.
  publishedCache.delete(dataset);
  datCache.delete(dataset);
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

/** Правила опубликованной версии (или [] — ещё не собирали). Кешируем по версии:
 *  их читает КАЖДАЯ выдача подписки, а JSON на сотни тысяч записей парсить на каждый
 *  запрос — это секунды. */
const publishedCache = new Map<string, { version: number; rules: StoredRule[] }>();
export function publishedRules(dataset = DATASET): StoredRule[] {
  const version = repo.getPublishedAutoRouteVersion(dataset);
  if (version == null) return [];
  const c = publishedCache.get(dataset);
  if (c && c.version === version) return c.rules;
  const raw = repo.getAutoRouteBuildRules(dataset, version);
  let rules: StoredRule[] = [];
  try {
    rules = raw ? (JSON.parse(raw) as StoredRule[]) : [];
  } catch {
    rules = [];
  }
  publishedCache.set(dataset, { version, rules });
  return rules;
}

// Потолок правил, ЗАШИВАЕМЫХ ВНУТРЬ Xray-конфига (routing.rules[].domain/ip). Он про
// клиентское приложение, а не про движок: замеры 28.08.2026 на Xray 26.3.27 —
//   inline  30k доменов → конфиг 0,85 МБ, старт 0,32 с, 26 МБ ОЗУ
//   inline 100k доменов → конфиг 2,87 МБ, старт 0,67 с, 31 МБ ОЗУ
// то есть сам Xray тянет и больше, а виснет Happ, когда пытается ОТКРЫТЬ мегабайтный
// JSON в интерфейсе. Поэтому потолок остаётся только здесь.
//
// К DAT он НЕ относится и относиться не должен (те же замеры, geosite.dat):
//    30k → 0,55 МБ, старт 0,36 с, 26 МБ      100k → 1,87 МБ, старт 0,36 с, 33 МБ
//   300k → 5,72 МБ, старт 6,3 с,  53 МБ        1M → 19,2 МБ, старт 9,4 с, 109 МБ
// Маршрутизация во всех случаях сработала верно, включая Telegram по голому IP.
// Публичный upstream.json и DAT отдаются БЕЗ потолка; клиент, умеющий DAT (Happ),
// получает конфиг на тегах geosite:novpn/geoip:novpn и всю базу целиком.
// Факт обрезки inline-списка виден в AutoRoute.
export const SUBSCRIPTION_CAP = 30_000;
// Потолок делится между доменами и подсетями: иначе 79k доменов Re:filter съедали весь
// лимит, а IP-подсетям (DC Telegram, CDN без SNI) доставалось три штуки. Подсети
// компактнее и их меньше — им отдельная квота.
const SUBSCRIPTION_CAP_IPS = 6_000;
const SUBSCRIPTION_CAP_DOMAINS = SUBSCRIPTION_CAP - SUBSCRIPTION_CAP_IPS;

/** Правила для Xray-подписки: только с действием «в VPN», в формате префиксов Xray
 *  (domain:/full:/keyword:/regexp:) и отдельно CIDR. Порядок = приоритет источников;
 *  у доменов и подсетей свои потолки. */
export function subscriptionRules(dataset = DATASET): { domains: string[]; ips: string[]; total: number; truncated: boolean } {
  const all = publishedRules(dataset).filter((r) => r.a === 'vpn');
  const domains: string[] = [];
  const ips: string[] = [];
  let truncated = false;
  // Порядок = приоритет источников, а встроенные правила (Telegram) идут первыми в
  // сборке — значит потолок их не срезает. Это и был корень «Telegram не работает через
  // умную»: его подсети лежали в базе ЗА границей 6000 IP и в телефонный конфиг не попадали.
  for (const r of all) {
    if (r.k === 'ip') {
      if (ips.length >= SUBSCRIPTION_CAP_IPS) truncated = true;
      else ips.push(r.v);
    } else if (domains.length >= SUBSCRIPTION_CAP_DOMAINS) truncated = true;
    else domains.push(`${r.k}:${r.v}`);
  }
  return { domains, ips, total: all.length, truncated };
}

/** Правила для DAT-конфига: сама база живёт в geosite/geoip, поэтому в конфиг попадают
 *  только ссылки на теги. Обязательные правила в DAT уже включены (см. datFiles). */
export function geoTagRules(): { domains: string[]; ips: string[] } {
  return { domains: [`geosite:${GEO_TAG}`], ips: [`geoip:${GEO_TAG}`] };
}

/** Публичные DAT-файлы из опубликованной сборки (кеш по версии: байты детерминированы). */
const datCache = new Map<string, { version: number; geosite: Buffer; geoip: Buffer }>();
export function datFiles(dataset = DATASET): { version: number | null; geosite: Buffer; geoip: Buffer } {
  const version = repo.getPublishedAutoRouteVersion(dataset);
  const c = datCache.get(dataset);
  if (version != null && c && c.version === version) return { version, geosite: c.geosite, geoip: c.geoip };
  // Встроенные правила уже внутри сборки (см. buildDataset) — отдельно их сюда не
  // подмешиваем, иначе они задвоятся в DAT.
  const rules = publishedRules(dataset).filter((r) => r.a === 'vpn');
  const geosite = encodeGeoSite(rules.filter((r) => r.k !== 'ip').map((r) => ({ kind: r.k as Exclude<typeof r.k, 'ip'>, value: r.v })));
  const geoip = encodeGeoIp(rules.filter((r) => r.k === 'ip').map((r) => r.v));
  if (version != null) datCache.set(dataset, { version, geosite, geoip });
  return { version, geosite, geoip };
}

/** Поиск по опубликованной сборке: что за правило, из какого источника, с каким
 *  приоритетом. Домен ищем и по точному значению, и по родительским доменам
 *  (запрос «api.openai.com» находит правило «openai.com»). */
export function searchRules(query: string, dataset = DATASET, limit = 50): AutoRouteSearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const sources = new Map(repo.listAutoRouteSources(dataset).map((s) => [s.id, s]));
  const parents = new Set<string>();
  const labels = q.split('.');
  for (let i = 0; i < labels.length - 1; i++) parents.add(labels.slice(i).join('.'));
  const hits: AutoRouteSearchHit[] = [];
  for (const r of publishedRules(dataset)) {
    const exact = r.v === q;
    const parent = r.k === 'domain' && parents.has(r.v);
    const partial = !exact && !parent && r.v.includes(q);
    if (!exact && !parent && !partial) continue;
    const s = sources.get(r.s);
    hits.push({ kind: r.k, value: r.v, action: r.a, sourceId: r.s, sourceTitle: s?.title ?? r.s, priority: s?.priority ?? 999 });
    if (hits.length >= limit * 4) break;
  }
  // Точные и родительские совпадения — первыми, затем частичные; внутри — по приоритету.
  const rank = (h: AutoRouteSearchHit) => (h.value === q ? 0 : parents.has(h.value) ? 1 : 2);
  return hits.sort((a, b) => rank(a) - rank(b) || a.priority - b.priority).slice(0, limit);
}

export function getState(origin: string, dataset = DATASET): AutoRouteState {
  const sub = subscriptionRules(dataset);
  return {
    dataset,
    sources: repo.listAutoRouteSources(dataset),
    builds: repo.listAutoRouteBuilds(dataset),
    publishedVersion: repo.getPublishedAutoRouteVersion(dataset),
    publicUrl: `${origin}/routing/${dataset}.json`,
    dat: { geosite: `${origin}/routing/autoroute/geosite.dat`, geoip: `${origin}/routing/autoroute/geoip.dat` },
    subscription: { rules: sub.domains.length + sub.ips.length, cap: SUBSCRIPTION_CAP, truncated: sub.truncated },
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

// ── автообновление ────────────────────────────────────────────────────────────
//
// Часовое зеркало (routingSync) обслуживает ТОЛЬКО старые одноисточниковые файлы и
// датасеты AutoRoute из выборки исключает — иначе затирало бы результат сборки. Из-за
// этого у AutoRoute автообновления не было вовсе: база стояла до следующего нажатия
// кнопки, и «подгружает недостающее само» не работало. Здесь — собственный цикл.
let autoRouteRunning = false;

/** Один проход автообновления по всем датасетам, у которых есть источники. */
export async function autoRouteTick(): Promise<void> {
  if (autoRouteRunning) return; // прошлый проход ещё идёт (источники бывают медленные)
  autoRouteRunning = true;
  try {
    for (const dataset of repo.listAutoRouteDatasets()) {
      try {
        const res = await refreshAllAndBuild(dataset);
        // Отказ публикации (пустая/похудевшая сборка) уже попал в журнал ошибок внутри
        // buildDataset — здесь не дублируем, пишем только реальные обновления.
        if (res.ok && res.build && !/Изменений нет/.test(res.reason)) {
          repo.addLog(`AutoRoute: автообновление — ${res.reason}`);
        }
      } catch (e) {
        repo.addJobError('Маршрутизация', `AutoRoute: автообновление не прошло — ${e instanceof Error ? e.message : 'сбой'}`, 'warn');
      }
    }
  } finally {
    autoRouteRunning = false;
  }
}

export function startAutoRouteLoop(intervalMs = 3_600_000): void {
  const t = setInterval(() => void autoRouteTick(), intervalMs);
  t.unref?.();
  // Первый проход — через минуту после старта: панель успевает подняться, и он не
  // сталкивается с зеркальным синком (тот стартует на 15-й секунде).
  setTimeout(() => void autoRouteTick(), 60_000).unref?.();
}
