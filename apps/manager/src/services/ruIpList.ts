// Российские сети (RIPE NCC) для приложений NoVPN. В «Полном VPN» и на резерве они идут
// напрямую: зарубежные серверы российское сами не выпускают («Российские сервисы мимо
// серверов», панель 1.5.8), и сайт на российском хостинге через туннель не открывался
// (10.11.2026: hostvds.com у владельца). Раздаём файлом /routing/ru-ip.txt — сеть на
// строку; движок приложения берёт его как rule-provider. Обновляем раз в сутки, последний
// удачный список лежит в базе: переживает перезапуск и сбой RIPE.

import crypto from 'node:crypto';
import { getSetting, setSetting } from '../db.js';

const SOURCE = 'https://stat.ripe.net/data/country-resource-list/data.json?resource=RU&v4_format=prefix';
const KEY = 'ru_ip_list';
/** Меньше — значит ответ RIPE неполный: такой список не берём, остаётся прошлый. */
const MIN_NETS = 1000;

export interface RuIpList {
  text: string;
  count: number;
  sha256: string;
  updatedAt: string;
}

/** Сеть IPv4 с обнулённым хвостом адреса («10.0.0.7/24» → «10.0.0.0/24»), иначе null. */
export function normV4(cidr: string): string | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr.trim());
  if (!m) return null;
  const parts = m.slice(1, 5).map(Number);
  const bits = Number(m[5]);
  if (parts.some((p) => p > 255) || bits > 32) return null;
  const n = ((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  const a = (n & mask) >>> 0;
  return `${a >>> 24}.${(a >>> 16) & 255}.${(a >>> 8) & 255}.${a & 255}/${bits}`;
}

/** Ответ RIPE → сети IPv4 без повторов, по порядку. */
export function parseRipeRu(body: unknown): string[] {
  const v4 = (body as { data?: { resources?: { ipv4?: unknown } } } | null)?.data?.resources?.ipv4;
  if (!Array.isArray(v4)) return [];
  const set = new Set<string>();
  for (const x of v4) {
    const n = typeof x === 'string' ? normV4(x) : null;
    if (n) set.add(n);
  }
  return [...set].sort();
}

export function getRuIpList(): RuIpList | null {
  const l = getSetting<RuIpList | null>(KEY, null);
  return l && typeof l.text === 'string' && l.count > 0 ? l : null;
}

/** Обновить список с RIPE. Не бросает: при сбое остаётся прошлый. Число сетей или null. */
export async function refreshRuIpList(fetchImpl: typeof fetch = fetch): Promise<number | null> {
  try {
    const r = await fetchImpl(SOURCE, { signal: AbortSignal.timeout(40_000) });
    if (!r.ok) return null;
    const nets = parseRipeRu(await r.json());
    if (nets.length < MIN_NETS) return null;
    const text = nets.join('\n') + '\n';
    setSetting(KEY, {
      text,
      count: nets.length,
      sha256: crypto.createHash('sha256').update(text).digest('hex'),
      updatedAt: new Date().toISOString(),
    } satisfies RuIpList);
    return nets.length;
  } catch {
    return null;
  }
}

export function startRuIpListLoop(intervalMs = 86_400_000): void {
  const t = setInterval(() => void refreshRuIpList(), intervalMs);
  t.unref?.();
  // Первый прогон вскоре после старта — даём панели подняться.
  setTimeout(() => void refreshRuIpList(), 20_000).unref?.();
}
