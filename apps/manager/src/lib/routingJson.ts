// Разбор структуры routing-JSON: корневой тип, число элементов и множество
// элементов (для diff «+добавлено/−удалено»). Считаем count/entries ТОЛЬКО когда
// структуру можно нормально определить (§11) — иначе null (в UI покажется «—»).

export type RootType = 'array' | 'object' | 'other';

export interface JsonShape {
  rootType: RootType;
  count: number | null;
  entries: string[] | null; // нормализованные ключи элементов для diff
}

// Частые обёртки-контейнеры массива в списках доменов/правил.
const ARRAY_KEYS = ['items', 'domains', 'rules', 'payload', 'list', 'hosts', 'entries', 'data'];

function entryKey(x: unknown): string {
  if (typeof x === 'string') return x;
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}

/** Определить корневой тип и (если получится) список элементов. */
export function analyzeShape(content: string): JsonShape {
  let v: unknown;
  try {
    v = JSON.parse(content);
  } catch {
    return { rootType: 'other', count: null, entries: null };
  }
  if (Array.isArray(v)) {
    return { rootType: 'array', count: v.length, entries: v.map(entryKey) };
  }
  if (v && typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    // объект с единственным «массивным» свойством → берём его как список элементов
    const arrKey = ARRAY_KEYS.find((k) => Array.isArray(obj[k]));
    if (arrKey) {
      const arr = obj[arrKey] as unknown[];
      return { rootType: 'object', count: arr.length, entries: arr.map(entryKey) };
    }
    // иначе трактуем ключи объекта как элементы (map доменов → правила)
    const keys = Object.keys(obj);
    return { rootType: 'object', count: keys.length, entries: keys };
  }
  return { rootType: 'other', count: null, entries: null };
}

/** Diff по множествам элементов. null, если хотя бы одна сторона неопределима. */
export function diffCounts(
  oldEntries: string[] | null,
  newEntries: string[] | null,
): { added: number | null; removed: number | null } {
  if (!oldEntries || !newEntries) return { added: null, removed: null };
  const o = new Set(oldEntries);
  const n = new Set(newEntries);
  let added = 0;
  let removed = 0;
  for (const e of n) if (!o.has(e)) added++;
  for (const e of o) if (!n.has(e)) removed++;
  return { added, removed };
}

/** Нормализованная форма для сравнения «изменилось ли» (игнор форматирования). */
export function normalizeJson(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content));
  } catch {
    return content;
  }
}
