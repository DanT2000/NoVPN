// Конвертация внешних источников умной маршрутизации в канонический JSON.
// Формат определяется по расширению URL. LST/TXT — построчные списки доменов;
// JSON — как есть; SRS — бинарный sing-box rule-set (декомпиляция в сервисе).

import type { RoutingSourceFormat } from '@novpn/shared';

/** Определить формат источника по расширению пути URL. Неизвестное → 'json'. */
export function detectSourceFormat(url: string): RoutingSourceFormat {
  let p = url;
  try {
    p = new URL(url).pathname;
  } catch {
    p = (url.split(/[?#]/)[0] ?? url).trim();
  }
  const m = /\.([a-z0-9]+)$/i.exec(p.trim());
  const ext = m ? m[1]!.toLowerCase() : '';
  if (ext === 'lst') return 'lst';
  if (ext === 'txt') return 'txt';
  if (ext === 'srs') return 'srs';
  return 'json';
}

export interface ListConversion {
  items: string[];
  lines: number; // всего строк получено
  valid: number; // прошли проверку (до дедупа) = items.length + dups
  skipped: number; // пустые/комментарии/невалидные
  dups: number; // дубликатов удалено
}

/** Хост валиден: домен (в т.ч. punycode/wildcard) или IPv4. Без пробелов, ≤253. */
export function isValidHost(s: string): boolean {
  if (!s || s.length > 253 || /\s/.test(s)) return false;
  const h = s.startsWith('*.') ? s.slice(2) : s.startsWith('.') ? s.slice(1) : s;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true; // IPv4
  return /^([a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z]{2,}$/.test(h);
}

/** Построчный список (LST/TXT) → нормализованные домены + статистика. */
export function convertList(raw: string): ListConversion {
  const rows = raw.split(/\r?\n/);
  const lines = rows.length;
  let skipped = 0;
  let valid = 0;
  let dups = 0;
  const seen = new Set<string>();
  const items: string[] = [];
  for (const row of rows) {
    let s = row.trim();
    if (!s || s.startsWith('#') || s.startsWith('//')) {
      skipped++;
      continue;
    }
    // inline-комментарий после решётки (# в хосте невалиден)
    const hash = s.indexOf('#');
    if (hash >= 0) s = s.slice(0, hash).trim();
    if (!s) {
      skipped++;
      continue;
    }
    s = s.replace(/^https?:\/\//i, ''); // убрать схему
    s = (s.split(/[/?#]/)[0] ?? '').trim(); // убрать path/query/hash
    s = s.toLowerCase();
    if (!isValidHost(s)) {
      skipped++;
      continue;
    }
    valid++;
    if (seen.has(s)) {
      dups++;
      continue;
    }
    seen.add(s);
    items.push(s);
  }
  return { items, lines, valid, skipped, dups };
}
