/* Связь с приложением NoVPN через нативные сообщения.

   Соединение делаем разовым на каждый запрос, а не постоянным. Постоянное
   держало бы процесс приложения привязанным к жизни служебного работника
   расширения, а тот в Manifest V3 засыпает когда захочет — получались бы
   висящие процессы и «отвалившийся» канал в самый нужный момент. */

const HOST = 'ru.appswire.novpn';

/* «Попутные домены» — как в ZeroOmega. Сайт редко живёт на одном домене: картинки на
   cdn.*, API на api.*, видео на своём CDN. Человек нажал «через VPN» на сайте, а
   половина страницы всё равно идёт напрямую и не грузится. Поэтому смотрим, какие
   сторонние хосты подгружала вкладка, и предлагаем отправить их тем же маршрутом.

   Только наблюдаем (webRequest.onCompleted), ничего не блокируем и не читаем: нужен
   лишь список хостов по вкладке. Данные живут в памяти работника и никуда не уходят. */
const related = new Map(); // tabId -> Map(host -> сколько раз)
const RELATED_CAP = 200;

/* Общая инфраструктура, которую нет смысла тащить в VPN: метрика, реклама, шрифты,
   публичные CDN — они есть на каждом сайте и работают откуда угодно. */
const NOISE = new Set([
  'google-analytics.com', 'googletagmanager.com', 'doubleclick.net', 'googlesyndication.com',
  'googleadservices.com', 'gstatic.com', 'googleapis.com', 'google.com', 'recaptcha.net',
  'cloudflare.com', 'cloudflareinsights.com', 'jsdelivr.net', 'unpkg.com', 'cdnjs.com',
  'facebook.net', 'facebook.com', 'fbcdn.net', 'twitter.com', 'x.com', 'sentry.io',
  'hotjar.com', 'criteo.com', 'adsrvr.org', 'adnxs.com', 'rubiconproject.com',
  'yandex.ru', 'yandex.net', 'mc.yandex.ru', 'yastatic.net', 'vk.com', 'mail.ru',
  'top-fwz1.mail.ru', 'bing.com', 'microsoft.com', 'live.com', 'apple.com', 'mozilla.org',
]);

const TWO_LEVEL = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'com.br', 'com.tr',
  'co.jp', 'ne.jp', 'co.kr', 'com.ua', 'net.ua', 'org.ua', 'com.ru', 'msk.ru', 'spb.ru',
  'com.cn', 'com.hk', 'com.tw', 'co.in', 'co.za', 'com.mx', 'com.ar',
]);

/** Регистрируемый домен: cdn.static.example.com → example.com, a.b.co.uk → b.co.uk.
    Правило в приложении — «домен и поддомены», поэтому предлагаем именно корень. */
function baseDomain(host) {
  const p = host.split('.');
  if (p.length <= 2) return host;
  const last2 = p.slice(-2).join('.');
  return TWO_LEVEL.has(last2) ? p.slice(-3).join('.') : last2;
}

function noteHost(tabId, url) {
  let host;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
    host = u.hostname.replace(/^www\./, '');
  } catch {
    return;
  }
  let m = related.get(tabId);
  if (!m) {
    m = new Map();
    related.set(tabId, m);
  }
  if (m.size >= RELATED_CAP && !m.has(host)) return;
  m.set(host, (m.get(host) || 0) + 1);
}

chrome.webRequest.onCompleted.addListener(
  (d) => {
    if (d.tabId < 0) return;
    noteHost(d.tabId, d.url);
  },
  { urls: ['<all_urls>'] },
);
// Новая навигация во вкладке — прошлые хосты к ней уже не относятся.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url || info.status === 'loading') related.delete(tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => related.delete(tabId));

/** Кандидаты «тоже отправить»: корневые домены сторонних хостов вкладки, без шума
    и без самого сайта, по убыванию частоты. Не больше восьми — иначе это не подсказка. */
function relatedFor(tabId, domain) {
  const m = related.get(tabId);
  if (!m) return [];
  const self = baseDomain(domain);
  const score = new Map();
  for (const [host, n] of m) {
    const base = baseDomain(host);
    if (base === self || NOISE.has(base) || NOISE.has(host)) continue;
    score.set(base, (score.get(base) || 0) + n);
  }
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([base, n]) => ({ domain: base, hits: n }));
}

/** Один запрос — одно соединение. Ответ приходит один. */
function ask(message) {
  return new Promise((resolve) => {
    let port;
    try {
      port = chrome.runtime.connectNative(HOST);
    } catch (e) {
      resolve({ ok: false, error: 'Приложение NoVPN не найдено' });
      return;
    }
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      try {
        port.disconnect();
      } catch {}
      resolve(value);
    };
    port.onMessage.addListener((msg) => finish(msg));
    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      // Причины разные, и человеку важно знать какая: хост не зарегистрирован
      // (приложение не ставили или ни разу не запускали) — это одно; браузер
      // отказал в доступе (расширение установлено под другим ID, чем ждёт
      // приложение) — совсем другое, и «перезапустите NoVPN» тут не поможет.
      const m = String((err && err.message) || '').toLowerCase();
      let error = 'Соединение закрыто';
      if (m.includes('not found')) error = 'Приложение NoVPN не установлено или ещё ни разу не запускалось — откройте его один раз';
      else if (m.includes('forbidden')) error = 'Расширение установлено под другим ID — переустановите его из свежего архива с сайта';
      else if (err) error = 'Приложение NoVPN не отвечает';
      finish({ ok: false, error });
    });
    // Приложение может быть занято подключением — но молчать бесконечно не должно.
    setTimeout(() => finish({ ok: false, error: 'Приложение NoVPN не отвечает' }), 4000);
    try {
      port.postMessage(message);
    } catch (e) {
      finish({ ok: false, error: 'Не удалось передать запрос' });
    }
  });
}

chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
  // Попутные домены отвечаем сами — это память работника, приложение тут не нужно.
  if (req && req.type === 'related') {
    sendResponse({ ok: true, items: relatedFor(Number(req.tabId), String(req.domain || '')) });
    return false;
  }
  ask(req).then(sendResponse);
  return true; // ответ придёт позже
});

/* Значок отражает маршрут открытого сайта: не нужно открывать окно, чтобы
   увидеть, куда сейчас ходит эта вкладка. */
async function paint(tabId, url) {
  const domain = domainOf(url);
  if (!domain) {
    await chrome.action.setBadgeText({ tabId, text: '' });
    return;
  }
  const r = await ask({ type: 'get', domain });
  const route = r && r.ok ? r.route : null;
  await chrome.action.setBadgeText({ tabId, text: route === 'vpn' ? 'VPN' : '' });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: '#0D7DD4' });
}

function domainOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'complete' && tab.url) void paint(tabId, tab.url);
});
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab && tab.url) void paint(tabId, tab.url);
});
