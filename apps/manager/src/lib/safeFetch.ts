// Защита исходящих запросов панели от SSRF и переполнения памяти.
//
// Резервную подписку URL задаёт ОБЫЧНЫЙ пользователь (PUT /sub/:token/backup/personal),
// и панель сама его фетчит. Без проверки это классический SSRF: указав
// http://169.254.169.254/ (метаданные облака), http://127.0.0.1:<порт>/ или адрес из
// внутренней сети 192.168.x, пользователь заставил бы панель сходить во внутреннюю
// инфраструктуру. Плюс тело ответа без ограничения буферизуется в память целиком —
// многогигабайтный ответ (или chunked без Content-Length) кладёт процесс по OOM.

import dns from 'node:dns/promises';
import { lookup as dnsLookupCb } from 'node:dns';
import type { LookupAddress, LookupAllOptions, LookupOptions } from 'node:dns';
import net from 'node:net';
import { Agent } from 'undici';

/** IP из внутренних/служебных диапазонов, на которые панели ходить нельзя. Неизвестное
 *  или некорректное значение трактуем как небезопасное (fail-closed). */
export function isPrivateIp(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) {
    const p = ip.split('.').map((x) => Number(x));
    if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const a = p[0] as number;
    const b = p[1] as number;
    if (a === 0) return true; // 0.0.0.0/8 «этот хост»
    if (a === 10) return true; // 10/8
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local + метаданные 169.254.169.254
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    if (a >= 224) return true; // multicast/reserved 224/4, 240/4
    return false;
  }
  if (kind === 6) {
    const low = ip.toLowerCase();
    if (low === '::1' || low === '::') return true; // loopback / unspecified
    // link-local fe80::/10 — весь первый хекстет fe80..febf (раньше 'fe80' ловил лишь fe80::,
    // а fe81..fe8f проскакивали).
    if (low.startsWith('fe8') || low.startsWith('fe9') || low.startsWith('fea') || low.startsWith('feb')) return true;
    if (low.startsWith('fc') || low.startsWith('fd')) return true; // ULA fc00::/7
    if (low.startsWith('ff')) return true; // multicast
    if (low.startsWith('64:ff9b:')) return true; // NAT64 64:ff9b::/96 — тоже мост во внутрянку
    // IPv4-mapped ::ffff:0:0/96 в ЛЮБОЙ записи: точечной (::ffff:127.0.0.1) И hex (::ffff:7f00:1).
    // Раньше ловилась только точечная — hex-форма обходила фильтр (SSRF на 127.0.0.1/metadata).
    const m = low.match(/^::ffff:(.+)$/);
    if (m) {
      const tail = m[1] as string;
      if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(tail)) return isPrivateIp(tail);
      const hx = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
      if (hx) {
        const hi = parseInt(hx[1] as string, 16);
        const lo = parseInt(hx[2] as string, 16);
        return isPrivateIp(`${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`);
      }
      return true; // ::ffff: с неожиданным хвостом — fail-closed
    }
    return false;
  }
  return true; // не распознано как IP — небезопасно
}

/** Бросает, если URL небезопасен: не http(s), либо хост резолвится во внутренний адрес.
 *  Для имени проверяем ВСЕ адреса (иначе A-запись на внутренний IP прошла бы). Остаточный
 *  риск — DNS-rebinding между проверкой и запросом (задокументирован в аудите). */
export async function assertPublicUrl(url: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error('некорректный URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('поддерживаются только http/https');
  const host = u.hostname.replace(/^\[/, '').replace(/\]$/, ''); // снять скобки IPv6
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('адрес указывает на внутреннюю сеть');
    return;
  }
  let addrs: Array<{ address: string }>;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    throw new Error('не удалось разрешить имя хоста');
  }
  if (addrs.length === 0) throw new Error('имя хоста не разрешается');
  for (const a of addrs) if (isPrivateIp(a.address)) throw new Error('имя хоста указывает на внутреннюю сеть');
}

/** Безопасный GET с РУЧНЫМИ перенаправлениями: каждый переход (и исходный URL, и
 *  каждый Location) заново проходит assertPublicUrl. Иначе публичный хост мог бы
 *  302-редиректом увести панель на внутренний/метаданный адрес, который при
 *  redirect:'follow' повторно НЕ проверяется (SSRF через редирект). Возвращает
 *  финальный ответ (в т.ч. 304 — он не редирект). Остаточный риск DNS-rebinding
 *  между проверкой и коннектом задокументирован в assertPublicUrl. */
/** Выбор формы результата кастомного lookup по контракту Node + fail-closed фильтр
 *  приватных адресов. Node ждёт массив при Happy-Eyeballs (options.all=true) и одиночный
 *  (address, family) иначе — форму легко сломать назад, поэтому выносим и покрываем тестом. */
export function resolveLookupForm(
  addresses: LookupAddress[],
  all: boolean | undefined,
):
  | { error: string }
  | { single: true; address: string; family: number }
  | { single: false; addresses: LookupAddress[] } {
  if (addresses.length === 0) return { error: 'имя хоста не разрешается' };
  for (const a of addresses) if (isPrivateIp(a.address)) return { error: 'адрес указывает на внутреннюю сеть' };
  if (all) return { single: false, addresses };
  const first = addresses[0]!;
  return { single: true, address: first.address, family: first.family };
}

// Диспетчер с ПРИВЯЗКОЙ адреса: DNS резолвится в самом коннекторе и КАЖДЫЙ полученный
// адрес заново проверяется на «внутренний». assertPublicUrl проверяет имя ДО запроса, но
// fetch затем резолвит имя повторно — атакующий с низким TTL мог бы вернуть публичный IP
// на проверке и внутренний (127.0.0.1 / 169.254.169.254 / 192.168.x) на коннекте
// (DNS-rebinding / TOCTOU). Здесь проверка идёт на ТОМ ЖЕ резолве, что и коннект, — окно
// закрыто. Ошибка резолва/приватный адрес → соединение не устанавливается (fail-closed).
const pinnedAgent = new Agent({
  connect: {
    lookup(
      hostname: string,
      options: LookupOptions,
      callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
    ) {
      dnsLookupCb(hostname, { ...options, all: true } as LookupAllOptions, (err, addresses) => {
        if (err) return callback(err, []);
        const r = resolveLookupForm(addresses, options.all);
        if ('error' in r) return callback(new Error(r.error), []);
        // Форма по контракту Node (см. resolveLookupForm): массив при all=true, иначе
        // одиночный (address, family) — иначе Node падает с ERR_INVALID_IP_ADDRESS.
        if (r.single) return callback(null, r.address, r.family);
        return callback(null, r.addresses);
      });
    },
  },
});

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
export async function safeFetch(
  url: string,
  init: { headers?: Record<string, string>; timeoutMs?: number; maxRedirects?: number } = {},
): Promise<Response> {
  const maxRedirects = init.maxRedirects ?? 5;
  // ОДИН дедлайн на ВСЮ цепочку редиректов. Раньше таймаут создавался на каждый hop —
  // и медленная/враждебная цепочка тянулась до (N+1)×timeout (~120с вместо 20с), держа
  // последовательный фоновый sync-цикл backupSync куда дольше задуманного.
  const signal = init.timeoutMs ? AbortSignal.timeout(init.timeoutMs) : undefined;
  let current = url;
  for (let hop = 0; ; hop++) {
    await assertPublicUrl(current); // проверяем КАЖДЫЙ адрес в цепочке, не только первый
    const res = await fetch(current, {
      method: 'GET',
      headers: init.headers,
      redirect: 'manual',
      signal,
      // Привязка адреса против DNS-rebinding (см. pinnedAgent). dispatcher — расширение
      // Node/undici поверх стандартного RequestInit, поэтому расширяем тип точечно.
      dispatcher: pinnedAgent,
    } as RequestInit & { dispatcher: unknown });
    if (!REDIRECT_CODES.has(res.status)) return res; // не редирект (в т.ч. 304) — отдаём как есть
    const loc = res.headers.get('location');
    if (!loc) return res;
    try {
      await res.body?.cancel();
    } catch {
      /* тело уже закрыто */
    }
    if (hop >= maxRedirects) throw new Error('слишком много перенаправлений');
    current = new URL(loc, current).toString();
  }
}

/** Читает тело ответа с жёстким лимитом в байтах, прерывая поток при превышении —
 *  в отличие от res.text(), которое буферизует весь ответ (обход Content-Length при
 *  chunked). Бросает при превышении лимита. */
export async function readTextCapped(res: Response, maxBytes: number): Promise<string> {
  const body = res.body as ReadableStream<Uint8Array> | null;
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength) {
        total += value.byteLength;
        if (total > maxBytes) {
          try {
            await reader.cancel();
          } catch {
            /* поток уже закрыт */
          }
          throw new Error('ответ превышает допустимый размер');
        }
        chunks.push(Buffer.from(value));
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* уже отпущен */
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}
