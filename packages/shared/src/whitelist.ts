// Российский «белый список» доменов — те, что остаются доступны даже в режиме
// ограничений («суверенный интернет»). В полном Xray-конфиге они маршрутизируются
// НАПРЯМУЮ (мимо VPN): домашние сервисы работают локально, остальное — через прокси.
// Формат — строки правил Xray routing (domain: — домен и поддомены, full: — точное).
// Источник — рабочий конфиг «Обход белых списков»; список можно расширять.

export const RU_WHITELIST_ROUTES: string[] = [
  'domain:2gis.ru', 'domain:2gis.com', 'domain:ads.x5.ru', 'domain:aif.ru', 'domain:aeroflot.ru',
  'domain:alfabank.ru', 'domain:aliexpress.ru', 'domain:aliexpress.com', 'domain:api.oneme.ru', 'domain:avito.ru', 'domain:beeline.ru',
  'domain:burgerkingrus.ru', 'domain:dellin.ru', 'domain:drive2.ru', 'domain:dzen.ru',
  'domain:fd.oneme.ru', 'domain:flypobeda.ru', 'domain:forbes.ru', 'domain:gazeta.ru',
  'domain:gazprombank.ru', 'domain:gismeteo.ru', 'domain:gosuslugi.ru', 'domain:hh.ru',
  'domain:i.oneme.ru', 'domain:kontur.ru', 'domain:kontur.host', 'domain:kp.ru', 'domain:kuper.ru',
  'domain:lenta.ru', 'domain:mail.ru', 'domain:max.ru', 'domain:megamarket.ru', 'domain:megamarket.tech',
  'domain:megafon.ru', 'domain:miniapps.max.ru', 'domain:moex.com', 'domain:motivtelecom.ru',
  'domain:ozon.ru', 'domain:pervye.ru', 'domain:psbank.ru', 'domain:rambler.ru', 'domain:rambler-co.ru',
  'domain:rbc.ru', 'domain:reg.ru', 'domain:reviews.2gis.com', 'domain:rg.ru', 'domain:ria.ru',
  'domain:rustore.ru', 'domain:rutube.ru', 'domain:ruwiki.ru', 'domain:rzd.ru',
  'domain:sdk-api.apptracer.ru', 'domain:sirena-travel.ru', 'domain:sravni.ru', 'domain:st.max.ru',
  'domain:t-j.ru', 'domain:t2.ru', 'domain:tank-online.com', 'domain:taximaxim.ru',
  'domain:tbank-online.com', 'domain:tildaapi.com', 'domain:tns-counter.ru',
  'domain:tracker-api.vk-analytics.ru', 'domain:trvl.yandex.net', 'domain:tutu.ru', 'domain:vk.com',
  'domain:vk.ru', 'domain:vkvideo.ru', 'domain:vtb.ru', 'domain:x5.ru',
  'domain:xn--90acagbhgpca7c8c7f.xn--p1ai', 'domain:xn--80ajghhoc2aj1c8b.xn--p1ai',
  'domain:xn--90aivcdt6dxbc.xn--p1ai', 'domain:xn--b1aew.xn--p1ai', 'domain:ya.ru', 'domain:yandex.ru',
  'domain:yandex.net', 'domain:yandex.com', 'domain:yandexcloud.net', 'domain:yastatic.net',
  'domain:sberbank.ru', 'domain:sber.ru', 'domain:tinkoff.ru', 'domain:t-bank.ru', 'domain:wildberries.ru',
  'domain:vtb24.ru', 'domain:nalog.ru', 'domain:nalog.gov.ru', 'domain:pochta.ru', 'domain:cdek.ru',
  // «Суверенные» сервисы/маркетплейсы/стриминги, ломающиеся под VPN (по списку пользователя):
  'domain:ok.ru', 'domain:lamoda.ru', 'domain:samokat.ru', 'domain:vkusvill.ru', 'domain:lenta.com',
  'domain:magnit.ru', 'domain:kinopoisk.ru', 'domain:ivi.ru', 'domain:start.ru', 'domain:kion.ru',
  'domain:wink.ru', 'domain:litres.ru', 'domain:cian.ru',
  // Российские магазины (электроника/ритейл), часто «вылетают» под VPN:
  'domain:dns-shop.ru', 'domain:mvideo.ru', 'domain:eldorado.ru', 'domain:citilink.ru',
  'domain:detmir.ru', 'domain:sportmaster.ru', 'domain:leroymerlin.ru', 'domain:lemanapro.ru',
  // Российские авиакомпании:
  'domain:utair.ru', 'domain:s7.ru', 'domain:uralairlines.ru', 'domain:rossiya-airlines.com', 'domain:nordwindairlines.ru',
  'domain:smartavia.com', 'domain:azimuth.aero', 'domain:flyredwings.com', 'domain:azurair.ru',
  // Список «Russia outside» (itdoginfo/allow-domains) — росс. ресурсы, отдающиеся
  // только росс. подсетям (гос/ЖКХ/утилиты). gov.ru покрывает *.gov.ru.
  'domain:gov.ru', 'domain:mos.ru', 'domain:mosreg.ru', 'domain:mosenergosbyt.ru', 'domain:pesc.ru',
  'domain:consultant.ru', 'domain:russianpost.ru', 'domain:emex.ru', 'domain:reso.ru', 'domain:rzd-bonus.ru',
  'domain:avtodor-tr.ru', 'domain:onelya.ru', 'domain:bkvet.ru', 'domain:dzvr.ru', 'domain:yadro.ru',
  'domain:gorzdrav.spb.ru', 'domain:gu-st.ru', 'domain:ozonusercontent.com', 'domain:refocus.ru', 'domain:ttk.ru',
  'domain:bitrix.info', 'domain:showip.net', 'domain:xn--90aijkdmaud0d.xn--p1ai', 'domain:1018213540.rsc.cdn77.org',
  'full:go.yandex', 'full:ru.ruwiki.ru',
];

/** Полный Xray-конфиг (V2RayNG / Xray-core) с обходом «белых списков»:
 *  RU-домены — напрямую, всё остальное — через reality-прокси. `links` — vless://
 *  reality-ссылки. `proxies` — резервные каналы В ПОРЯДКЕ ПРИОРИТЕТА (HTTPS, HTTP,
 *  SOCKS): аварийный доступ, если Xray заблокируют. Возвращает JSON-строку. */
export interface ProxyFallback {
  kind: 'https' | 'http' | 'socks';
  host: string;
  port: number;
  user: string;
  pass: string;
}

const PRIVATE_IPS = ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '::1/128', 'fc00::/7', 'fe80::/10'];

/** Нормализация строки правила из редактируемого админкой списка: пустые/комментарии
 *  отбрасываем; строку без известного префикса считаем доменом (→ domain:X). */
export function normalizeWhitelistRoutes(raw: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line0 of raw) {
    const line = String(line0).trim();
    if (!line || line.startsWith('#')) continue;
    const rule = /^(domain|full|regexp|keyword|geosite):/i.test(line) ? line : `domain:${line}`;
    if (!seen.has(rule)) {
      seen.add(rule);
      out.push(rule);
    }
  }
  return out;
}

function proxyOutbound(p: ProxyFallback): Record<string, unknown> {
  if (p.kind === 'socks') {
    return { protocol: 'socks', settings: { servers: [{ address: p.host, port: p.port, users: [{ user: p.user, pass: p.pass }] }] } };
  }
  const o: Record<string, unknown> = {
    protocol: 'http',
    settings: { servers: [{ address: p.host, port: p.port, users: [{ user: p.user, pass: p.pass }] }] },
  };
  if (p.kind === 'https') o.streamSettings = { security: 'tls', tlsSettings: { serverName: p.host } };
  return o;
}

/** Дополнительные параметры сборки конфига (см. buildWhitelistXrayConfig). */
export interface XrayBuildOptions {
  /** `match-direct` (унаследованный обход белых списков): список → напрямую, остальное в
   *  VPN. `match-vpn` (умная маршрутизация по AutoRoute): список → VPN, остальное напрямую. */
  direction?: 'match-direct' | 'match-vpn';
  /** CIDR-правила той же направленности, что и доменный список (из AutoRoute). */
  ipRoutes?: string[];
  /** Служебные метаданные для клиентского приложения (кладутся в `meta.novpn`).
   *  Xray-core незнакомые поля игнорирует, Happ читает `meta.serverDescription`. */
  novpn?: Record<string, unknown>;
  /** Приписка к имени профиля: « · Умная маршрутизация» у умного. Полный VPN остаётся
   *  просто именем сервера — так в приложении видно, какой из двух профилей «умный». */
  remarkSuffix?: string;
}

export function buildWhitelistXrayConfig(
  links: string[],
  appName = 'NoVPN',
  proxies: ProxyFallback[] = [],
  title = '',
  whitelistRoutes: string[] = RU_WHITELIST_ROUTES,
  lanAccess = false,
  disableWhitelist = false,
  opts: XrayBuildOptions = {},
): string {
  // Имя профиля (remarks) = имя сервера с флагом, ровно как в панели («🇫🇷 Франция»).
  // Режим в название НЕ добавляем — кроме явной приписки умного профиля
  // (« · Умная маршрутизация»), иначе два профиля одного сервера были бы неотличимы.
  const remarks = (title || appName) + (opts.remarkSuffix ?? '');
  const matchVpn = opts.direction === 'match-vpn';
  // Список доменов может приходить из редактируемой настройки админки; нормализуем.
  // В унаследованном режиме пустой список = встроенный RU-дефолт (иначе обход бы не
  // работал). В режиме match-vpn пустой список — это честная «пустая сборка»: подставлять
  // RU-домены как «то, что идёт в VPN» было бы ровно наоборот.
  const routes = normalizeWhitelistRoutes(whitelistRoutes);
  const wlRoutes = routes.length ? routes : matchVpn ? [] : RU_WHITELIST_ROUTES;
  const ipRoutes = (opts.ipRoutes ?? []).filter(Boolean);
  // Тиры в порядке приоритета: 0 = Xray (reality), затем каждый прокси — свой тир.
  const tiers: Array<Record<string, unknown>[]> = [];
  const xray = links.map(parseVlessLink).filter((o): o is Record<string, unknown> => !!o);
  if (xray.length) tiers.push(xray);
  for (const p of proxies) tiers.push([proxyOutbound(p)]);
  // Нет НИ ОДНОГО валидного канала (все ссылки битые и прокси нет) → не отдаём конфиг,
  // где весь трафик идёт direct (это была бы полная утечка без VPN). Возвращаем ''.
  if (tiers.length === 0) return '';

  const outbounds: Array<Record<string, unknown>> = [];
  tiers.forEach((tier, ti) =>
    tier.forEach((o, oi) => {
      o.tag = `proxy-t${ti}-${oi}`;
      outbounds.push(o);
    }),
  );
  outbounds.push({ protocol: 'freedom', tag: 'direct' });
  outbounds.push({ protocol: 'blackhole', tag: 'block' });

  // sniffing КРИТИЧЕН для обхода: без него правила domain: не срабатывают для HTTPS
  // (в TUN-режиме роутер видит только IP, а не домен → росс. сайты уходят через VPN
  // вместо direct). destOverride tls/http/quic извлекает домен из хендшейка;
  // routeOnly:true — используем его ТОЛЬКО для маршрутизации, соединяемся с оригиналом.
  const sniffing = { enabled: true, destOverride: ['http', 'tls', 'quic'], routeOnly: true };
  const inbounds: Array<Record<string, unknown>> = [
    { tag: 'socks', listen: '127.0.0.1', port: 10808, protocol: 'socks', settings: { auth: 'noauth', udp: true }, sniffing },
    { tag: 'http', listen: '127.0.0.1', port: 10809, protocol: 'http', settings: { allowTransparent: false }, sniffing },
  ];
  // Куда уходит СПИСОК. match-direct (обход белых списков): список → direct. match-vpn
  // (умная маршрутизация): список → в туннель, а туннель — это первый тир либо
  // балансировщик lb0 (несколько серверов/тиров); терминальное правило тогда → direct.
  // При disableWhitelist (полный туннель) доменных правил нет вовсе.
  const listTarget = matchVpn ? (proxies.length || xray.length > 1 ? { balancerTag: 'lb0' } : { outboundTag: 'proxy-t0-0' }) : { outboundTag: 'direct' };
  const whitelistRules = [
    ...(disableWhitelist || !wlRoutes.length ? [] : [{ type: 'field', ...listTarget, domain: wlRoutes }]),
    ...(disableWhitelist || !ipRoutes.length ? [] : [{ type: 'field', ...listTarget, ip: ipRoutes }]),
    // Приватные/локальные адреса. По умолчанию (lanAccess=false) — напрямую (клиент
    // держит свою локалку сам, приватные адреса не уходят в туннель). При lanAccess=true
    // это правило УБИРАЕМ: приватные адреса пойдут через прокси/туннель к серверу — так
    // самохостер добирается до локальной сети СВОЕГО сервера (дома) через VPN.
    ...(lanAccess ? [] : [{ type: 'field', outboundTag: 'direct', ip: PRIVATE_IPS }]),
    // Торренты — мимо VPN (при disableWhitelist тоже убираем: никаких исключений).
    // В match-vpn база и так direct — отдельное правило не нужно.
    ...(disableWhitelist || matchVpn ? [] : [{ type: 'field', outboundTag: 'direct', protocol: ['bittorrent'] }]),
  ];
  // Терминальное правило: куда уходит всё, что не попало в список. match-direct → в
  // туннель (первый тир / балансировщик); match-vpn → напрямую. Полный туннель → в туннель.
  const restTarget = matchVpn && !disableWhitelist ? 'direct' : null;
  const meta: Record<string, unknown> = { serverDescription: remarks, ...(opts.novpn ? { novpn: opts.novpn } : {}) };
  // QUIC (UDP/443) через прокси-цепочку нестабилен: YouTube/Google-сервисы «зависают»,
  // т.к. браузер открыл QUIC, а UDP по VLESS/прокси теряется, и отката на TCP не происходит.
  // Блокируем UDP/443 → браузер сразу падает на надёжный HTTP/2 (TCP). RU-домены уже ушли
  // direct правилами выше, их QUIC этот блок не затрагивает (порядок правил: whitelist → quic).
  const quicBlock = { type: 'field', outboundTag: 'block', network: 'udp', port: 443 };
  // Терминальный аварийный fallback балансировщиков. В обычном режиме — 'direct' (все
  // каналы мертвы → остаёмся в сети напрямую, осознанный компромисс). В полном туннеле
  // (disableWhitelist) пользователь ЯВНО выбрал «весь трафик через VPN» — падать в direct
  // = утечка реального IP открытым текстом, поэтому fail-close: 'block' (blackhole).
  const failFallback = disableWhitelist ? 'block' : 'direct';

  // Один тир (только Xray или только прокси) — без аварийного переключения между тирами.
  if (tiers.length <= 1) {
    const tier0 = tiers[0] ?? [];
    const rules: Array<Record<string, unknown>> = [...whitelistRules, quicBlock];
    const cfg: Record<string, unknown> = {
      remarks,
      meta,
      log: { loglevel: 'warning' },
      inbounds,
      outbounds,
      routing: { domainMatcher: 'hybrid', domainStrategy: 'AsIs', rules },
    };
    if (tier0.length > 1) {
      // Несколько Xray-серверов (без прокси) — балансируем по ним (leastPing), иначе
      // использовался бы только первый; все мертвы → напрямую.
      cfg.observatory = { subjectSelector: ['proxy-t0-'], probeUrl: 'https://www.cloudflare.com/cdn-cgi/trace', probeInterval: '30s', enableConcurrency: true };
      (cfg.routing as Record<string, unknown>).balancers = [{ tag: 'lb0', selector: ['proxy-t0-'], fallbackTag: failFallback, strategy: { type: 'leastPing' } }];
      if (restTarget) rules.push({ type: 'field', outboundTag: restTarget, network: 'tcp,udp' });
      else rules.push({ type: 'field', inboundTag: ['socks', 'http'], balancerTag: 'lb0', network: 'tcp,udp' });
    } else {
      rules.push({ type: 'field', outboundTag: restTarget ?? (tier0.length ? 'proxy-t0-0' : 'direct'), network: 'tcp,udp' });
    }
    return JSON.stringify(cfg, null, 2);
  }

  // Несколько тиров — строгий приоритет через цепочку балансировщиков с fallbackTag.
  // Xray жив → идём через него; заблокировали → балансировщик пуст → fallbackTag на
  // следующий тир (loopback возвращает трафик через dokodemo-инбаунд), и так до SOCKS,
  // а если все мертвы — напрямую. observatory следит за живостью тиров.
  const n = tiers.length;
  const rules: Array<Record<string, unknown>> = [...whitelistRules, quicBlock];
  const balancers: Array<Record<string, unknown>> = [];
  for (let i = 1; i < n; i++) {
    inbounds.push({
      tag: `t${i}-in`,
      listen: '127.0.0.1',
      port: 10810 + i,
      protocol: 'dokodemo-door',
      settings: { address: '127.0.0.1', network: 'tcp,udp', port: 0 },
    });
    outbounds.push({ protocol: 'loopback', tag: `loop-${i}`, settings: { inboundTag: `t${i}-in` } });
  }
  // match-vpn: не попавшее в список — напрямую; иначе весь входящий трафик — в цепочку тиров.
  if (restTarget) rules.push({ type: 'field', outboundTag: restTarget, network: 'tcp,udp' });
  else rules.push({ type: 'field', inboundTag: ['socks', 'http'], balancerTag: 'lb0', network: 'tcp,udp' });
  for (let i = 0; i < n; i++) {
    if (i > 0) rules.push({ type: 'field', inboundTag: [`t${i}-in`], balancerTag: `lb${i}` });
    balancers.push({
      tag: `lb${i}`,
      selector: [`proxy-t${i}-`],
      fallbackTag: i < n - 1 ? `loop-${i + 1}` : failFallback,
      strategy: { type: 'leastPing' },
    });
  }
  // Тот же meta, что и в однотирной ветке: без novpn десктоп не отличал умный профиль
  // от полного у сервера с резервными прокси (у обоих один host).
  const cfg = {
    remarks,
    meta,
    log: { loglevel: 'warning' },
    inbounds,
    outbounds,
    observatory: { subjectSelector: ['proxy-t'], probeUrl: 'https://www.cloudflare.com/cdn-cgi/trace', probeInterval: '30s', enableConcurrency: true },
    routing: { domainMatcher: 'hybrid', domainStrategy: 'AsIs', rules, balancers },
  };
  return JSON.stringify(cfg, null, 2);
}

/** Разбор vless://reality-ссылки в Xray-outbound. */
function parseVlessLink(link: string): Record<string, unknown> | null {
  try {
    const u = new URL(link);
    if (u.protocol !== 'vless:') return null;
    const q = u.searchParams;
    return {
      protocol: 'vless',
      settings: {
        vnext: [
          {
            address: u.hostname,
            port: Number(u.port) || 443,
            users: [{ id: decodeURIComponent(u.username), encryption: 'none', flow: q.get('flow') || '' }],
          },
        ],
      },
      streamSettings: {
        network: q.get('type') || 'tcp',
        security: q.get('security') || 'reality',
        realitySettings: {
          serverName: q.get('sni') || '',
          fingerprint: q.get('fp') || 'chrome',
          publicKey: q.get('pbk') || '',
          shortId: q.get('sid') || '',
          spiderX: q.get('spx') || '/',
        },
      },
    };
  } catch {
    return null;
  }
}
