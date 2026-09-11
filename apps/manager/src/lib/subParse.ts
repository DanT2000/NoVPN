// Разбор ЧУЖИХ подписок (резервная маршрутизация).
//
// Панель до сих пор только ГЕНЕРИРОВАЛА свои конфиги и никогда не разбирала
// внешние. Здесь — лёгкий разбор ответа сторонней подписки в список серверов:
// протокол, хост, порт, имя и исходная ссылка. Полную ссылку мы храним как
// есть и отдаём клиенту — на устройстве её разберёт тот же движок, что и
// обычную подписку. Наша задача — вытащить достаточно для админки (что за
// серверы) и для устойчивого идентификатора (host:port).
//
// Форматы ответа, которые встречаются у провайдеров:
//  - base64 от списка строк vless://…\nvmess://… (самый частый);
//  - тот же список открытым текстом;
//  - Clash-YAML (proxies:) — разбираем эвристикой, без зависимости от YAML.

export type BackupProto = 'vless' | 'vmess' | 'trojan' | 'ss' | 'unknown';

export interface BackupNode {
  /** Понятное имя из #фрагмента / ps / name, иначе host:port. */
  name: string;
  /** Исходная строка конфига — её отдаём клиенту без изменений. */
  link: string;
  host: string;
  port: number;
  protocol: BackupProto;
}

export interface ParsedSub {
  format: 'base64' | 'plain' | 'clash' | 'unknown';
  nodes: BackupNode[];
}

/** Статистика подписки из заголовка ответа `Subscription-Userinfo`. */
export interface SubUserinfo {
  /** Отдано, байт. */
  upload?: number;
  /** Скачано, байт. */
  download?: number;
  /** Лимит, байт. 0 у провайдера обычно означает «безлимит». */
  total?: number;
  /** Срок действия, unix-секунды. */
  expire?: number;
}

const SCHEMES = ['vless://', 'vmess://', 'trojan://', 'ss://'];

/** Похоже на base64 (только алфавит base64 и пробелы) и достаточно длинное. */
function looksBase64(s: string): boolean {
  const t = s.replace(/\s+/g, '');
  return t.length >= 24 && t.length % 4 <= 3 && /^[A-Za-z0-9+/=_-]+$/.test(t);
}

function b64decode(s: string): string {
  // Терпим и обычный, и url-safe base64, и отсутствие padding.
  const t = s.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = t.length % 4 === 0 ? t : t + '='.repeat(4 - (t.length % 4));
  return Buffer.from(pad, 'base64').toString('utf8');
}

/** Если тело — base64 от списка ссылок, вернуть раскодированный текст, иначе исходный. */
function decodeBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed.includes('://')) return trimmed; // уже открытый текст
  if (!looksBase64(trimmed)) return trimmed;
  const decoded = b64decode(trimmed);
  return decoded.includes('://') ? decoded : trimmed;
}

function clampPort(n: number): number {
  return Number.isFinite(n) && n >= 1 && n <= 65535 ? Math.trunc(n) : 443;
}

function nameOr(name: string | undefined, host: string, port: number): string {
  const n = (name ?? '').trim();
  return n || `${host}:${port}`;
}

/** vless:// и trojan:// — WHATWG URL разбирает authority у любой схемы. */
function parseUrlLike(line: string, proto: BackupProto): BackupNode | null {
  try {
    const u = new URL(line);
    const host = u.hostname.replace(/^\[|\]$/g, ''); // IPv6 без скобок
    if (!host) return null;
    const port = clampPort(Number(u.port || 443));
    const name = u.hash ? decodeURIComponent(u.hash.slice(1)) : '';
    return { name: nameOr(name, host, port), link: line, host, port, protocol: proto };
  } catch {
    return null;
  }
}

/** vmess:// — base64 от JSON {add, port, ps, …}. */
function parseVmess(line: string): BackupNode | null {
  try {
    const json = JSON.parse(b64decode(line.slice('vmess://'.length)));
    const host = String(json.add ?? json.host ?? '').trim();
    if (!host) return null;
    const port = clampPort(Number(json.port));
    const name = String(json.ps ?? '').trim();
    return { name: nameOr(name, host, port), link: line, host, port, protocol: 'vmess' };
  } catch {
    return null;
  }
}

/** ss:// — либо base64(method:pass)@host:port, либо base64(method:pass@host:port). */
function parseSs(line: string): BackupNode | null {
  try {
    const hash = line.indexOf('#');
    const name = hash >= 0 ? decodeURIComponent(line.slice(hash + 1)) : '';
    let body = line.slice('ss://'.length, hash >= 0 ? hash : undefined);
    const q = body.indexOf('?');
    if (q >= 0) body = body.slice(0, q);
    let host = '';
    let port = 443;
    const at = body.lastIndexOf('@');
    if (at >= 0) {
      const hp = body.slice(at + 1);
      const c = hp.lastIndexOf(':');
      host = hp.slice(0, c).replace(/^\[|\]$/g, '');
      port = clampPort(Number(hp.slice(c + 1)));
    } else {
      // Всё тело — base64(method:pass@host:port)
      const dec = b64decode(body);
      const a = dec.lastIndexOf('@');
      const hp = a >= 0 ? dec.slice(a + 1) : dec;
      const c = hp.lastIndexOf(':');
      host = hp.slice(0, c).replace(/^\[|\]$/g, '');
      port = clampPort(Number(hp.slice(c + 1)));
    }
    if (!host) return null;
    return { name: nameOr(name, host, port), link: line, host, port, protocol: 'ss' };
  } catch {
    return null;
  }
}

function parseLine(raw: string): BackupNode | null {
  const line = raw.trim();
  if (line.startsWith('vless://')) return parseUrlLike(line, 'vless');
  if (line.startsWith('trojan://')) return parseUrlLike(line, 'trojan');
  if (line.startsWith('vmess://')) return parseVmess(line);
  if (line.startsWith('ss://')) return parseSs(line);
  return null;
}

/** Clash-YAML без зависимости от парсера YAML: тянем name/server/port из блока proxies. */
function parseClash(body: string): BackupNode[] {
  const out: BackupNode[] = [];
  // Каждый proxy — это `- {name: …, server: …, port: …, type: …}` или блок
  // с отступами. Работаем построчно и собираем по одному объекту за раз.
  let cur: { name?: string; server?: string; port?: number; type?: string } = {};
  const flush = () => {
    if (cur.server && cur.port) {
      const proto = (['vless', 'vmess', 'trojan', 'ss'] as const).find((p) => p === cur.type) ?? 'unknown';
      out.push({
        name: nameOr(cur.name, cur.server, cur.port),
        // Своей ссылки у Clash-узла нет — храним минимальный маркер, клиент возьмёт
        // из общего конфига. Для пула важны host/port/имя.
        link: '',
        host: cur.server,
        port: clampPort(cur.port),
        protocol: proto,
      });
    }
    cur = {};
  };
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('- ') || line.startsWith('-{') || line === '-') {
      flush();
    }
    const m = line.match(/(?:^|[,{]\s*)(name|server|port|type)\s*:\s*("?)([^",}]+)\2/g);
    if (m) {
      for (const pair of m) {
        const mm = pair.match(/(name|server|port|type)\s*:\s*("?)([^",}]+)\2/);
        if (!mm || mm[3] === undefined) continue;
        const key = mm[1];
        const val = mm[3].trim();
        if (key === 'port') cur.port = Number(val);
        else if (key === 'name') cur.name = val;
        else if (key === 'server') cur.server = val;
        else if (key === 'type') cur.type = val;
      }
    }
  }
  flush();
  return out;
}

/** Разобрать тело ответа подписки в список серверов. Никогда не бросает. */
export function parseSubscription(body: string): ParsedSub {
  if (!body || !body.trim()) return { format: 'unknown', nodes: [] };
  const trimmed = body.trim();

  // Clash-YAML определяем по ключу proxies: до раскодирования base64.
  if (/^\s*(port|proxies|proxy-groups|mixed-port)\s*:/m.test(trimmed) && /proxies\s*:/.test(trimmed)) {
    const nodes = dedupe(parseClash(trimmed));
    return { format: 'clash', nodes };
  }

  const wasBase64 = !trimmed.includes('://') && looksBase64(trimmed);
  const text = decodeBody(trimmed);
  const nodes: BackupNode[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (SCHEMES.some((s) => line.trim().startsWith(s))) {
      const n = parseLine(line);
      if (n) nodes.push(n);
    }
  }
  return { format: wasBase64 ? 'base64' : nodes.length ? 'plain' : 'unknown', nodes: dedupe(nodes) };
}

/** Убрать точные повторы по (protocol, host, port). */
function dedupe(nodes: BackupNode[]): BackupNode[] {
  const seen = new Set<string>();
  const out: BackupNode[] = [];
  for (const n of nodes) {
    const key = `${n.protocol}|${n.host}|${n.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

/** Разобрать заголовок `Subscription-Userinfo: upload=…; download=…; total=…; expire=…`. */
export function parseSubUserinfo(header: string | null | undefined): SubUserinfo {
  const out: SubUserinfo = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const num = Number(part.slice(eq + 1).trim());
    if (!Number.isFinite(num)) continue;
    if (key === 'upload') out.upload = num;
    else if (key === 'download') out.download = num;
    else if (key === 'total') out.total = num;
    else if (key === 'expire') out.expire = num;
  }
  return out;
}
