// AutoRoute: приведение любого источника к единому набору правил.
//
// На входе — уже сконвертированный в текст источник (LST/TXT построчно, JSON как
// есть, SRS после decompile через sing-box). На выходе — нормализованные правила
// вида {kind, value}. Дальше сборщик сливает правила разных источников по приоритету.
//
// Виды правил намеренно совпадают с префиксами Xray routing (domain/full/keyword/
// regexp) плюс ip для CIDR — чтобы на этапе выдачи конфигов ничего не переводить.

import type { RoutingRuleKind } from '@novpn/shared';
import { isValidHost } from './routingConvert.js';

export interface ParsedRule {
  kind: RoutingRuleKind;
  value: string;
}

export interface ParseResult {
  rules: ParsedRule[];
  lines: number;
  valid: number;
  skipped: number;
  dups: number;
}

/** Ключ дедупликации/слияния: одно и то же значение одного вида — одна запись. */
export function ruleKey(r: ParsedRule): string {
  return `${r.kind}:${r.value}`;
}

const IPV4_CIDR = /^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/;
const IPV6_CIDR = /^[0-9a-f:]+(\/\d{1,3})?$/i;

function isIpv4Cidr(s: string): boolean {
  if (!IPV4_CIDR.test(s)) return false;
  const [addr, mask] = s.split('/');
  if (mask != null && (Number(mask) < 0 || Number(mask) > 32)) return false;
  return addr!.split('.').every((o) => Number(o) <= 255);
}
function isIpv6Cidr(s: string): boolean {
  if (!s.includes(':') || !IPV6_CIDR.test(s)) return false;
  const [addr, mask] = s.split('/');
  if (mask != null && (Number(mask) < 0 || Number(mask) > 128)) return false;
  // грубая проверка: 2..8 групп, каждая ≤4 hex-символов
  const groups = addr!.split(':');
  return groups.length >= 2 && groups.length <= 8 && groups.every((g) => g.length <= 4);
}

/**
 * Одна строка источника → правило. null, если строку следует пропустить.
 * Понимает префиксы Xray (domain:/full:/keyword:/regexp:), CIDR/IP и голый домен.
 * `geosite:` осознанно пропускаем: это ссылка на категорию чужой базы, развернуть
 * её в домены мы не можем, а протащить как «домен» — получить мусорное правило.
 */
export function parseRuleLine(raw: string): ParsedRule | null {
  let s = raw.trim();
  if (!s || s.startsWith('#') || s.startsWith('//') || s.startsWith('!')) return null;
  const hash = s.indexOf('#');
  if (hash >= 0) s = s.slice(0, hash).trim();
  if (!s) return null;

  const m = /^([a-z]+):(.*)$/i.exec(s);
  if (m) {
    const prefix = m[1]!.toLowerCase();
    const rest = m[2]!.trim();
    if (!rest) return null;
    if (prefix === 'regexp') return { kind: 'regexp', value: rest };
    if (prefix === 'keyword') return { kind: 'keyword', value: rest.toLowerCase() };
    if (prefix === 'full') return isValidHost(rest.toLowerCase()) ? { kind: 'full', value: rest.toLowerCase() } : null;
    if (prefix === 'domain') return isValidHost(rest.toLowerCase()) ? { kind: 'domain', value: rest.toLowerCase() } : null;
    if (prefix === 'geosite' || prefix === 'geoip' || prefix === 'ext') return null;
    if (prefix === 'ip' || prefix === 'cidr') s = rest;
    else if (prefix === 'http' || prefix === 'https') s = rest.replace(/^\/\//, '');
    // иначе — префикс не наш (например, порт в «host:443»), обрабатываем строку целиком
  }

  // CIDR проверяем ДО срезания пути: маска отделяется тем же слэшем, и «10.0.0.0/8»
  // иначе превратилось бы в «10.0.0.0» — правило на один адрес вместо целой сети.
  if (isIpv4Cidr(s) || isIpv6Cidr(s)) return { kind: 'ip', value: s.toLowerCase() };

  // URL-остатки: схема уже снята выше, режем путь/порт
  s = (s.split(/[/?#\s]/)[0] ?? '').trim();
  if (!s) return null;

  // голый адрес без маски (например, из «https://1.2.3.4/path»)
  if (isIpv4Cidr(s) || isIpv6Cidr(s)) return { kind: 'ip', value: s.toLowerCase() };

  // хост может прийти с портом — «example.com:443»
  const portCut = /^([^:]+):\d+$/.exec(s);
  if (portCut) s = portCut[1]!;

  s = s.toLowerCase().replace(/^\*\./, '').replace(/^\./, '');
  return isValidHost(s) ? { kind: 'domain', value: s } : null;
}

function pushLines(lines: string[], out: ParsedRule[], seen: Set<string>, acc: ParseResult): void {
  for (const line of lines) {
    acc.lines++;
    const rule = parseRuleLine(line);
    if (!rule) {
      acc.skipped++;
      continue;
    }
    acc.valid++;
    const k = ruleKey(rule);
    if (seen.has(k)) {
      acc.dups++;
      continue;
    }
    seen.add(k);
    out.push(rule);
  }
}

/** Собрать строки из произвольной JSON-структуры источника. */
function collectFromJson(root: unknown, out: string[]): void {
  // sing-box source rule-set: {version, rules:[{domain:[], domain_suffix:[], ...}]}
  if (root && typeof root === 'object' && Array.isArray((root as { rules?: unknown }).rules)) {
    for (const r of (root as { rules: unknown[] }).rules) {
      if (!r || typeof r !== 'object') continue;
      const o = r as Record<string, unknown>;
      const take = (key: string, prefix: string) => {
        const v = o[key];
        if (typeof v === 'string') out.push(prefix + v);
        else if (Array.isArray(v)) for (const x of v) if (typeof x === 'string') out.push(prefix + x);
      };
      take('domain', 'full:');
      take('domain_suffix', 'domain:');
      take('domain_keyword', 'keyword:');
      take('domain_regex', 'regexp:');
      take('ip_cidr', 'ip:');
    }
    return;
  }
  // {items:[...]} — наш канонический формат
  if (root && typeof root === 'object' && Array.isArray((root as { items?: unknown }).items)) {
    for (const x of (root as { items: unknown[] }).items) if (typeof x === 'string') out.push(x);
    return;
  }
  // голый массив строк
  if (Array.isArray(root)) {
    for (const x of root) {
      if (typeof x === 'string') out.push(x);
      else if (x && typeof x === 'object') collectFromJson(x, out);
    }
    return;
  }
  // объект-словарь: берём строковые значения и массивы строк
  if (root && typeof root === 'object') {
    for (const v of Object.values(root as Record<string, unknown>)) {
      if (typeof v === 'string') out.push(v);
      else if (Array.isArray(v) || (v && typeof v === 'object')) collectFromJson(v, out);
    }
  }
}

/** Разобрать источник в правила. `asJson` — текст уже является JSON (json/srs). */
export function parseSource(text: string, asJson: boolean): ParseResult {
  const acc: ParseResult = { rules: [], lines: 0, valid: 0, skipped: 0, dups: 0 };
  const seen = new Set<string>();
  if (asJson) {
    let root: unknown;
    try {
      root = JSON.parse(text);
    } catch {
      return acc; // невалидный JSON — вызывающий уже отбраковал, но подстрахуемся
    }
    const lines: string[] = [];
    collectFromJson(root, lines);
    pushLines(lines, acc.rules, seen, acc);
    return acc;
  }
  pushLines(text.split(/\r?\n/), acc.rules, seen, acc);
  return acc;
}
