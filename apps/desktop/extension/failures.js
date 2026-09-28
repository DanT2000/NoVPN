/* Что на странице НЕ загрузилось — чтобы предлагать маршрут для реально сломанного,
   а не для всего подряд, что страница подтянула (прежние «попутные домены» советовали
   YouTube на сайте MSI только потому, что там встроено видео).

   Принцип тот же, что у SwitchyOmega/ZeroOmega: следим за исходом КАЖДОГО запроса
   вкладки и считаем проблемой только ошибки соединения и запросы, которые повисли без
   ответа. Реализация своя (их код под GPL, копировать не стали).

   Здесь только чистые функции без chrome.* — так логику проверяет обычный тест
   (test/failures.test.js). Файл грузится и в service worker (importScripts), и в
   фоновую страницу Firefox (background.scripts). */
(function (root) {
  'use strict';

  /** Без заголовков ответа дольше — запрос «не отвечает». У XHR/fetch порог выше:
      там бывают законно долгие опросы сервера (long polling). */
  const HUNG_MS = 10000;
  const HUNG_XHR_MS = 20000;
  /** Эти запросы живут долго по своей природе — «зависшими» их не считаем. */
  const NEVER_HUNG = new Set(['websocket', 'ping', 'beacon', 'csp_report', 'media']);

  /* Не сбой сети, а нормальная жизнь страницы: отмена (ушли со страницы, скрипт отменил
     fetch), блокировщик рекламы и политики браузера (…BLOCKED…), кэш, локальные схемы,
     пропавший интернет целиком (тогда сломано всё, и маршрут сайта ни при чём),
     0.0.0.0 от DNS-фильтра (AdGuard/Pi-hole режут рекламу именно так). */
  const NOT_A_FAILURE =
    /ERR_ABORTED|NS_BINDING_ABORTED|NS_ERROR_ABORT|BLOCKED|ERR_CACHE_|ERR_INCOMPLETE_CHUNKED|ERR_FILE_|UNKNOWN_URL_SCHEME|ERR_INVALID_URL|ERR_UNSAFE_|ERR_NETWORK_CHANGED|ERR_INTERNET_DISCONNECTED|NS_ERROR_OFFLINE|ERR_ADDRESS_INVALID|ERR_TOO_MANY_REDIRECTS|ERR_INVALID_RESPONSE|ERR_CONTENT_|ERR_RESPONSE_HEADERS_|ERR_INVALID_CHUNKED/i;

  /* Код ошибки → причина человеческими словами. Порядок важен: первое совпадение. */
  const REASONS = [
    [/CONNECTION_RESET|CONNECTION_CLOSED|CONNECTION_ABORTED|EMPTY_RESPONSE|SOCKET_NOT_CONNECTED|NS_ERROR_NET_RESET|NS_ERROR_NET_INTERRUPT|NET_INTERRUPT/i, 'сброс соединения'],
    [/TIMED_OUT|NS_ERROR_NET_TIMEOUT/i, 'нет ответа'],
    [/NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|NS_ERROR_UNKNOWN_HOST|DNS_/i, 'адрес не найден'],
    [/CONNECTION_REFUSED|NS_ERROR_CONNECTION_REFUSED/i, 'соединение отклонено'],
    [/SSL|CERT|TLS|SEC_ERROR|NS_ERROR_GENERATE_FAILURE/i, 'ошибка защищённого соединения'],
    [/QUIC|HTTP2|SPDY|HTTP_1_1_REQUIRED/i, 'обрыв соединения'],
    [/ADDRESS_UNREACHABLE|NETWORK_ACCESS_DENIED|NETWORK_IO_SUSPENDED/i, 'сервер недоступен'],
    [/PROXY|TUNNEL_CONNECTION_FAILED/i, 'ошибка прокси'],
  ];
  const REASON_HUNG = 'не отвечает';

  /** Причина сбоя или null, если это не сбой сети. */
  function classify(error) {
    const e = String(error || '');
    if (!e || NOT_A_FAILURE.test(e)) return null;
    for (const [re, reason] of REASONS) if (re.test(e)) return reason;
    return 'ошибка ' + e.replace(/^net::ERR_/, '').replace(/^NS_ERROR_/, '').toLowerCase();
  }

  /** Повис ли запрос: заголовков ответа нет дольше порога. Долгоживущие типы — никогда. */
  function hungReason(req, now) {
    if (!req || req.headers || NEVER_HUNG.has(req.type)) return null;
    const limit = req.type === 'xmlhttprequest' ? HUNG_XHR_MS : HUNG_MS;
    return now - req.start >= limit ? REASON_HUNG : null;
  }

  const TWO_LEVEL = new Set([
    'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'com.br', 'com.tr',
    'co.jp', 'ne.jp', 'co.kr', 'com.ua', 'net.ua', 'org.ua', 'com.ru', 'msk.ru', 'spb.ru',
    'com.cn', 'com.hk', 'com.tw', 'co.in', 'co.za', 'com.mx', 'com.ar',
  ]);

  /** Регистрируемый домен: cdn.static.example.com → example.com, a.b.co.uk → b.co.uk.
      Правило в приложении — «домен и поддомены», поэтому предлагаем именно корень. */
  function baseDomain(host) {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) return host; // IP как есть
    const p = host.split('.');
    if (p.length <= 2) return host;
    const last2 = p.slice(-2).join('.');
    return TWO_LEVEL.has(last2) ? p.slice(-3).join('.') : last2;
  }

  /** Хост запроса или null — для не-http(s) и для локальной сети: её маршрут не выбирают. */
  function hostOf(url) {
    let h;
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      h = u.hostname.toLowerCase().replace(/^www\./, '').replace(/^\[|\]$/g, '');
    } catch {
      return null;
    }
    if (!h || h === 'localhost' || /\.(local|lan|internal|home|home\.arpa|localhost)$/.test(h)) return null;
    const m = h.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
    if (m) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      if (a === 10 || a === 127 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) || (a === 198 && (b === 18 || b === 19))) return null;
    }
    if (h === '::1' || /^f[cd]|^fe80/i.test(h)) return null;
    return h;
  }

  /* Реклама, аналитика, трекеры: их сбой человеку неинтересен (часто это и есть работа
     блокировщика), а в списке они заслонили бы то, что реально сломало страницу. */
  const NOISE_BASE = new Set([
    'google-analytics.com', 'googletagmanager.com', 'doubleclick.net', 'googlesyndication.com',
    'googleadservices.com', 'adservice.google.com', 'hotjar.com', 'criteo.com', 'criteo.net',
    'adsrvr.org', 'adnxs.com', 'rubiconproject.com', 'pubmatic.com', 'openx.net', 'taboola.com',
    'outbrain.com', 'scorecardresearch.com', 'quantserve.com', 'amplitude.com', 'mixpanel.com',
    'segment.io', 'segment.com', 'newrelic.com', 'nr-data.net', 'clarity.ms', 'sentry.io',
    'cloudflareinsights.com', 'facebook.net', 'onesignal.com', 'moatads.com', 'yieldmo.com',
    'adform.net', 'adriver.ru', 'tns-counter.ru', 'mediator.media', 'mgid.com', 'smartadserver.com',
  ]);
  const NOISE_HOST = new Set(['mc.yandex.ru', 'an.yandex.ru', 'top-fwz1.mail.ru', 'bat.bing.com', 'stats.g.doubleclick.net', 'connect.facebook.net']);

  function isNoise(host) {
    return NOISE_HOST.has(host) || NOISE_BASE.has(baseDomain(host));
  }

  /**
   * Сводка для окна: домены (по корню) со сбоями — записанными ошибками и тем, что висит
   * прямо сейчас. Самые частые первыми; реклама отброшена; не больше `limit`.
   * @param failures {[base]: {n, reasons: {[reason]: n}, main: bool}}
   * @param inflight [{host, type, start, headers}] — ещё не завершённые запросы вкладки
   * @param selfDomain домен открытого сайта — помечаем «сам сайт»
   */
  function summarize(failures, inflight, now, selfDomain, limit) {
    const acc = new Map();
    const add = (base, reason, n, main) => {
      let x = acc.get(base);
      if (!x) acc.set(base, (x = { n: 0, reasons: new Map(), main: false }));
      x.n += n;
      x.reasons.set(reason, (x.reasons.get(reason) || 0) + n);
      x.main = x.main || Boolean(main);
    };
    for (const [base, f] of Object.entries(failures || {})) {
      for (const [reason, n] of Object.entries(f.reasons || {})) add(base, reason, n, f.main);
    }
    for (const req of inflight || []) {
      const reason = hungReason(req, now);
      if (reason && !isNoise(req.host)) add(baseDomain(req.host), reason, 1, req.type === 'main_frame');
    }
    const self = selfDomain ? baseDomain(selfDomain) : null;
    return [...acc.entries()]
      .filter(([base]) => !NOISE_BASE.has(base))
      .map(([base, x]) => {
        const reason = [...x.reasons.entries()].sort((a, b) => b[1] - a[1])[0][0];
        return { domain: base, count: x.n, reason, self: base === self || x.main };
      })
      .sort((a, b) => Number(b.self) - Number(a.self) || b.count - a.count)
      .slice(0, limit || 10);
  }

  /** Записать сбой в структуру вкладки (мутирует и возвращает её). */
  function record(failures, host, reason, main) {
    const base = baseDomain(host);
    const f = (failures[base] = failures[base] || { n: 0, reasons: {}, main: false });
    f.n += 1;
    f.reasons[reason] = (f.reasons[reason] || 0) + 1;
    f.main = f.main || Boolean(main);
    return failures;
  }

  root.NovpnFailures = { classify, hungReason, baseDomain, hostOf, isNoise, summarize, record, HUNG_MS, HUNG_XHR_MS, REASON_HUNG };
})(typeof self !== 'undefined' ? self : globalThis);
