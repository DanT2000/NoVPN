// Российский «белый список» доменов — те, что остаются доступны даже в режиме
// ограничений («суверенный интернет»). В полном Xray-конфиге они маршрутизируются
// НАПРЯМУЮ (мимо VPN): домашние сервисы работают локально, остальное — через прокси.
// Формат — строки правил Xray routing (domain: — домен и поддомены, full: — точное).
// Источник — рабочий конфиг «Обход белых списков»; список можно расширять.

export const RU_WHITELIST_ROUTES: string[] = [
  'domain:2gis.ru', 'domain:2gis.com', 'domain:ads.x5.ru', 'domain:aif.ru', 'domain:aeroflot.ru',
  'domain:alfabank.ru', 'domain:api.oneme.ru', 'domain:avito.ru', 'domain:beeline.ru',
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
  'full:go.yandex', 'full:ru.ruwiki.ru',
];

/** Полный Xray-конфиг (V2RayNG / Xray-core) с обходом «белых списков»:
 *  RU-домены — напрямую, всё остальное — через reality-прокси. `links` — vless://
 *  reality-ссылки пользователя (по одной на сервер). Возвращает JSON-строку. */
export function buildWhitelistXrayConfig(links: string[], appName = 'NoVPN'): string {
  const outbounds: Array<Record<string, unknown>> = [];
  const proxyTags: string[] = [];
  links.forEach((link, i) => {
    const o = parseVlessLink(link);
    if (!o) return;
    const tag = `proxy-${i}`;
    proxyTags.push(tag);
    o.tag = tag;
    outbounds.push(o);
  });
  outbounds.push({ protocol: 'freedom', tag: 'direct' });
  outbounds.push({ protocol: 'blackhole', tag: 'block' });

  const cfg = {
    remarks: `${appName} — обход белых списков`,
    log: { loglevel: 'warning' },
    inbounds: [
      { tag: 'socks', listen: '127.0.0.1', port: 10808, protocol: 'socks', settings: { auth: 'noauth', udp: true } },
      { tag: 'http', listen: '127.0.0.1', port: 10809, protocol: 'http' },
    ],
    outbounds,
    routing: {
      domainStrategy: 'AsIs',
      rules: [
        // Российские «белые» домены — напрямую (работают даже в режиме белого списка).
        { type: 'field', outboundTag: 'direct', domain: RU_WHITELIST_ROUTES },
        // Приватные/локальные адреса — напрямую. Явные подсети (без geoip.dat,
        // чтобы конфиг был самодостаточным для любого клиента).
        {
          type: 'field',
          outboundTag: 'direct',
          ip: ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '::1/128', 'fc00::/7', 'fe80::/10'],
        },
        // Торренты — мимо VPN (не грузим прокси).
        { type: 'field', outboundTag: 'direct', protocol: ['bittorrent'] },
        // Всё остальное — через первый рабочий прокси.
        { type: 'field', outboundTag: proxyTags[0] ?? 'direct', network: 'tcp,udp' },
      ],
    },
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
