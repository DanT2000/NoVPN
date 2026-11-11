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
  format: 'base64' | 'plain' | 'clash' | 'xray-json' | 'unknown';
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

/** Терпимый decodeURIComponent: кривая escape-последовательность (одиночный «%» в
 *  имени) НЕ должна ронять весь узел — деградируем к сырой строке имени. */
function tryDecodeComponent(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** vless:// и trojan:// — WHATWG URL разбирает authority у любой схемы. */
function parseUrlLike(line: string, proto: BackupProto): BackupNode | null {
  try {
    const u = new URL(line);
    const host = u.hostname.replace(/^\[|\]$/g, ''); // IPv6 без скобок
    if (!host) return null;
    const port = clampPort(Number(u.port || 443));
    const name = u.hash ? tryDecodeComponent(u.hash.slice(1)) : '';
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

/** Разбор authority `host:port`. Учитывает IPv6 в скобках и отсутствие порта:
 *  прежде без ':' host терял последний символ (hp.slice(0,-1)), а порт становился NaN. */
function splitHostPort(hp: string): { host: string; port: number } {
  if (hp.startsWith('[')) {
    const close = hp.indexOf(']');
    if (close >= 0) {
      const rest = hp.slice(close + 1);
      const p = rest.startsWith(':') ? rest.slice(1).split('/')[0] : '';
      return { host: hp.slice(1, close), port: rest.startsWith(':') ? clampPort(Number(p)) : 443 };
    }
  }
  const c = hp.lastIndexOf(':');
  if (c < 0) return { host: hp, port: 443 };
  // Срезаем путь `port/...` (SIP002 ss с плагином) — иначе порт становился 443. Как в sub.rs.
  const portStr = hp.slice(c + 1).split('/')[0];
  return { host: hp.slice(0, c), port: clampPort(Number(portStr)) };
}

/** ss:// — либо base64(method:pass)@host:port, либо base64(method:pass@host:port). */
function parseSs(line: string): BackupNode | null {
  try {
    const hash = line.indexOf('#');
    // Терпимо, как у vless/trojan: одиночный «%» в имени («50%off») ронял весь узел.
    const name = hash >= 0 ? tryDecodeComponent(line.slice(hash + 1)) : '';
    let body = line.slice('ss://'.length, hash >= 0 ? hash : undefined);
    const q = body.indexOf('?');
    if (q >= 0) body = body.slice(0, q);
    let host = '';
    let port = 443;
    const at = body.lastIndexOf('@');
    if (at >= 0) {
      ({ host, port } = splitHostPort(body.slice(at + 1)));
    } else {
      // Всё тело — base64(method:pass@host:port)
      const dec = b64decode(body);
      const a = dec.lastIndexOf('@');
      ({ host, port } = splitHostPort(a >= 0 ? dec.slice(a + 1) : dec));
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

// ── Xray-JSON (массив полных конфигов v2rayN) → share-ссылки ────────────────
// Некоторые провайдеры (BuzzVPN и т.п.) отдают не список ссылок, а JSON-массив
// готовых Xray-конфигов, у каждого remarks (имя) и outbounds с прокси. Собираем
// из них стандартные vless://…/vmess://… ссылки — тот же формат, что понимает
// клиент. Реконструируем то, что реально используют: vless (reality/tls/none)
// поверх tcp/ws/grpc/xhttp/httpupgrade, плюс vmess/trojan/ss.

function q(params: Array<[string, string | undefined | null]>): string {
  const parts = params
    .filter(([, v]) => v !== undefined && v !== null && `${v}` !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return parts.length ? '?' + parts.join('&') : '';
}

/** Параметры транспорта/безопасности из streamSettings в стиль share-ссылки. */
function streamParams(ss: any): Array<[string, string | undefined]> {
  const net = ss?.network ?? 'tcp';
  const sec = ss?.security ?? 'none';
  const out: Array<[string, string | undefined]> = [
    ['type', net],
    ['security', sec],
  ];
  if (sec === 'reality') {
    const r = ss?.realitySettings ?? {};
    out.push(['sni', r.serverName], ['fp', r.fingerprint], ['pbk', r.publicKey], ['sid', r.shortId], ['spx', r.spiderX]);
  } else if (sec === 'tls' || sec === 'xtls') {
    const t = ss?.tlsSettings ?? {};
    out.push(['sni', t.serverName]);
    if (t.fingerprint) out.push(['fp', t.fingerprint]);
    if (Array.isArray(t.alpn) && t.alpn.length) out.push(['alpn', t.alpn.join(',')]);
    if (t.allowInsecure) out.push(['allowInsecure', '1']);
  }
  if (net === 'ws') {
    const w = ss?.wsSettings ?? {};
    out.push(['path', w.path], ['host', w.headers?.Host ?? w.host]);
  } else if (net === 'grpc') {
    const g = ss?.grpcSettings ?? {};
    out.push(['serviceName', g.serviceName], ['mode', g.multiMode ? 'multi' : 'gun']);
  } else if (net === 'tcp') {
    const t = ss?.tcpSettings ?? {};
    const type = t?.header?.type;
    if (type && type !== 'none') {
      out.push(['headerType', type]);
      const host = t?.header?.request?.headers?.Host;
      if (Array.isArray(host) && host.length) out.push(['host', host.join(',')]);
    }
  } else if (net === 'http' || net === 'h2') {
    const h = ss?.httpSettings ?? {};
    out.push(['path', h.path]);
    if (Array.isArray(h.host) && h.host.length) out.push(['host', h.host.join(',')]);
  } else if (net === 'xhttp' || net === 'splithttp') {
    // Без пути, хоста и режима клиент стучится в «/», а сервер ждёт свой путь — узел
    // резерва не подключится никогда. 30.09.2026 клиенты научились брать их из ссылки,
    // но ссылку из Xray-JSON собирает панель, и до клиента они не доходили.
    const x = ss?.xhttpSettings ?? ss?.splithttpSettings ?? {};
    out.push(['path', x.path], ['host', x.host ?? x.headers?.Host], ['mode', x.mode]);
    const extra = xhttpExtra(x);
    if (extra) out.push(['extra', extra]);
  } else if (net === 'httpupgrade') {
    const h = ss?.httpupgradeSettings ?? {};
    out.push(['path', h.path], ['host', h.host ?? h.headers?.Host]);
  }
  return out;
}

/** `extra` share-ссылки XHTTP (формат v2rayN) — JSON строкой. Xray, получив extra,
 *  берёт из исходных настроек только path/host/mode, а остальное — из extra. Поэтому:
 *  есть extra у провайдера — отдаём его как есть; нет — собираем его из прочих полей
 *  (xPaddingBytes, noGRPCHeader, xmux…), иначе они бы молча пропали. */
function xhttpExtra(x: any): string | undefined {
  if (x?.extra && typeof x.extra === 'object') {
    return Object.keys(x.extra).length ? JSON.stringify(x.extra) : undefined;
  }
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(x ?? {})) {
    if (k === 'path' || k === 'host' || k === 'mode' || k === 'extra' || v === undefined || v === null) continue;
    if (k === 'headers' && v && typeof v === 'object') {
      // Host из заголовков уже ушёл в host — дублировать его в extra незачем.
      const h = { ...(v as Record<string, unknown>) };
      delete h.Host;
      if (Object.keys(h).length) rest.headers = h;
      continue;
    }
    rest[k] = v;
  }
  return Object.keys(rest).length ? JSON.stringify(rest) : undefined;
}

/** path/host транспорта — для vmess, у которого они лежат в JSON ссылки, а не в query. */
function transportPathHost(ss: any): { path: string; host: string } {
  const net = ss?.network ?? 'tcp';
  const str = (v: unknown) => (typeof v === 'string' ? v : Array.isArray(v) ? v.join(',') : '');
  if (net === 'ws') return { path: str(ss?.wsSettings?.path), host: str(ss?.wsSettings?.headers?.Host ?? ss?.wsSettings?.host) };
  if (net === 'xhttp' || net === 'splithttp') {
    const x = ss?.xhttpSettings ?? ss?.splithttpSettings ?? {};
    return { path: str(x.path), host: str(x.host ?? x.headers?.Host) };
  }
  if (net === 'httpupgrade') return { path: str(ss?.httpupgradeSettings?.path), host: str(ss?.httpupgradeSettings?.host ?? ss?.httpupgradeSettings?.headers?.Host) };
  if (net === 'http' || net === 'h2') return { path: str(ss?.httpSettings?.path), host: str(ss?.httpSettings?.host) };
  if (net === 'grpc') return { path: str(ss?.grpcSettings?.serviceName), host: '' };
  return { path: '', host: str(ss?.tcpSettings?.header?.request?.headers?.Host) };
}

function outboundToLink(ob: any, name: string): BackupNode | null {
  const proto = ob?.protocol;
  const ss = ob?.streamSettings ?? {};
  try {
    if (proto === 'vless' || proto === 'vmess') {
      const v = ob?.settings?.vnext?.[0];
      const user = v?.users?.[0];
      const host = String(v?.address ?? '').trim();
      const port = clampPort(Number(v?.port));
      const id = String(user?.id ?? '').trim();
      if (!host || !id) return null;
      if (proto === 'vless') {
        const params: Array<[string, string | undefined]> = [
          ['encryption', 'none'],
          ...(user?.flow ? [['flow', String(user.flow)] as [string, string]] : []),
          ...streamParams(ss),
        ];
        const link = `vless://${id}@${host}:${port}${q(params)}#${encodeURIComponent(name)}`;
        return { name: nameOr(name, host, port), link, host, port, protocol: 'vless' };
      }
      // vmess: собираем классический vmess://base64(json). path/host — по транспорту
      // (раньше только из wsSettings: у xhttp/grpc/httpupgrade они терялись).
      const w = transportPathHost(ss);
      const t = ss?.tlsSettings ?? {};
      const vm = {
        v: '2',
        ps: name,
        add: host,
        port: String(port),
        id,
        aid: String(user?.alterId ?? 0),
        scy: user?.security ?? 'auto',
        net: ss?.network ?? 'tcp',
        type: ss?.tcpSettings?.header?.type ?? 'none',
        host: w.host,
        path: w.path,
        tls: ss?.security === 'tls' ? 'tls' : '',
        sni: t.serverName ?? '',
      };
      const link = 'vmess://' + Buffer.from(JSON.stringify(vm)).toString('base64');
      return { name: nameOr(name, host, port), link, host, port, protocol: 'vmess' };
    }
    if (proto === 'trojan') {
      const s = ob?.settings?.servers?.[0];
      const host = String(s?.address ?? '').trim();
      const port = clampPort(Number(s?.port));
      const pass = String(s?.password ?? '').trim();
      if (!host || !pass) return null;
      const link = `trojan://${encodeURIComponent(pass)}@${host}:${port}${q(streamParams(ss))}#${encodeURIComponent(name)}`;
      return { name: nameOr(name, host, port), link, host, port, protocol: 'trojan' };
    }
    if (proto === 'shadowsocks') {
      const s = ob?.settings?.servers?.[0];
      const host = String(s?.address ?? '').trim();
      const port = clampPort(Number(s?.port));
      const method = String(s?.method ?? '').trim();
      const pass = String(s?.password ?? '').trim();
      if (!host || !method) return null;
      const userinfo = Buffer.from(`${method}:${pass}`).toString('base64');
      const link = `ss://${userinfo}@${host}:${port}#${encodeURIComponent(name)}`;
      return { name: nameOr(name, host, port), link, host, port, protocol: 'ss' };
    }
  } catch {
    return null;
  }
  return null;
}

/** Разобрать Xray-JSON (массив/один конфиг) в узлы со ссылками. */
function parseXrayJson(body: string): BackupNode[] {
  const data = JSON.parse(body);
  const configs: any[] = Array.isArray(data) ? data : [data];
  const single: BackupNode[] = [];
  const multi: BackupNode[] = [];
  for (const cfg of configs) {
    const obs: any[] = Array.isArray(cfg?.outbounds) ? cfg.outbounds : [];
    // Звенья цепочки (на них ссылается другой outbound через dialerProxy/proxySettings)
    // отдельными серверами не считаем: это промежуточный хоп, а не выход.
    const hops = new Set<string>();
    for (const o of obs) {
      const via = o?.streamSettings?.sockopt?.dialerProxy ?? o?.proxySettings?.tag;
      if (typeof via === 'string' && via) hops.add(via);
    }
    // ВСЕ прокси-outbound'ы (freedom/blackhole пропускаем): конфиг с балансировщиком
    // держит несколько серверов, а раньше брался только первый — остальные терялись.
    const proxies = obs.filter((o) => ['vless', 'vmess', 'trojan', 'shadowsocks'].includes(o?.protocol) && !hops.has(o?.tag));
    if (!proxies.length) continue;
    const remarks = String(cfg?.remarks ?? cfg?.tag ?? '').trim();
    proxies.forEach((proxy, i) => {
      // Несколько серверов в одном конфиге — различаем их тегом, иначе имена совпадут.
      const suffix = String(proxy?.tag ?? '').trim() || `#${i + 1}`;
      const name = proxies.length > 1 ? [remarks, suffix].filter(Boolean).join(' · ') : remarks;
      const node = outboundToLink(proxy, name);
      if (node) (proxies.length > 1 ? multi : single).push(node);
    });
  }
  // Одиночные конфиги — первыми: если провайдер отдаёт и «Авто»-конфиг со всеми
  // серверами, и каждый сервер отдельно, при дедупе остаются понятные имена отдельных.
  return [...single, ...multi];
}

/** Похоже ли тело на Xray-JSON (массив конфигов или конфиг с outbounds). */
function looksXrayJson(trimmed: string): boolean {
  if (!(trimmed.startsWith('[') || trimmed.startsWith('{'))) return false;
  return trimmed.includes('"outbounds"');
}

/** Разбор Xray-JSON, который никогда не бросает. */
function runCatchingXray(trimmed: string): BackupNode[] {
  try {
    return parseXrayJson(trimmed);
  } catch {
    return [];
  }
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
        // Своей ссылки у Clash-узла нет, а клиенту уходят ТОЛЬКО ссылки — такой узел
        // годится лишь для показа в админке. backupSync ответ без единой ссылки
        // считает ошибкой и рабочий пул им не затирает.
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

  // Xray-JSON: массив готовых конфигов v2rayN (BuzzVPN и подобные).
  if (looksXrayJson(trimmed)) {
    const nodes = dedupe(runCatchingXray(trimmed));
    if (nodes.length) return { format: 'xray-json', nodes };
  }

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

/** Ключ точного повтора: ссылка без #имени (у vmess — JSON без ps). Один host:port —
 *  ещё не повтор: на одном адресе живут разные конфиги (варианты SNI под белые списки
 *  разных операторов, CDN-ws с разным path/Host, reality и xhttp на одном 443), и
 *  прежний ключ protocol|host|port оставлял только первый — нужный оператору
 *  вариант мог молча пропасть. Одинаковые имена клиенты переименуют сами. */
function dedupeKey(n: BackupNode): string {
  // У Clash-узла ссылки нет — различаем ещё и по имени, чтобы не схлопнуть разные прокси.
  if (!n.link) return `${n.protocol}|${n.host}|${n.port}|${n.name}`;
  if (n.link.startsWith('vmess://')) {
    try {
      const j = JSON.parse(b64decode(n.link.slice('vmess://'.length))) as Record<string, unknown>;
      delete j.ps;
      return 'vmess://' + JSON.stringify(Object.keys(j).sort().map((k) => [k, j[k]]));
    } catch {
      /* не JSON — сравниваем как есть */
    }
  }
  const hash = n.link.indexOf('#');
  return hash >= 0 ? n.link.slice(0, hash) : n.link;
}

/** Убрать точные повторы (см. dedupeKey). */
function dedupe(nodes: BackupNode[]): BackupNode[] {
  const seen = new Set<string>();
  const out: BackupNode[] = [];
  for (const n of nodes) {
    const key = dedupeKey(n);
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
