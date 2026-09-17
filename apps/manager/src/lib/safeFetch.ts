// Защита исходящих запросов панели от SSRF и переполнения памяти.
//
// Резервную подписку URL задаёт ОБЫЧНЫЙ пользователь (PUT /sub/:token/backup/personal),
// и панель сама его фетчит. Без проверки это классический SSRF: указав
// http://169.254.169.254/ (метаданные облака), http://127.0.0.1:<порт>/ или адрес из
// внутренней сети 192.168.x, пользователь заставил бы панель сходить во внутреннюю
// инфраструктуру. Плюс тело ответа без ограничения буферизуется в память целиком —
// многогигабайтный ответ (или chunked без Content-Length) кладёт процесс по OOM.

import dns from 'node:dns/promises';
import net from 'node:net';

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
    if (low.startsWith('fe80') || low.startsWith('fe9') || low.startsWith('fea') || low.startsWith('feb')) return true; // link-local fe80::/10
    if (low.startsWith('fc') || low.startsWith('fd')) return true; // ULA fc00::/7
    if (low.startsWith('ff')) return true; // multicast
    const mapped = low.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/); // IPv4-mapped
    if (mapped && mapped[1]) return isPrivateIp(mapped[1]);
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
