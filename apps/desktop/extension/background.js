/* Связь с приложением NoVPN через нативные сообщения.

   Соединение делаем разовым на каждый запрос, а не постоянным. Постоянное
   держало бы процесс приложения привязанным к жизни служебного работника
   расширения, а тот в Manifest V3 засыпает когда захочет — получались бы
   висящие процессы и «отвалившийся» канал в самый нужный момент. */

const HOST = 'ru.appswire.novpn';

/* Что на странице НЕ загрузилось — как в ZeroOmega/SwitchyOmega, но своя реализация
   (логика — failures.js, её проверяет тест). Следим за исходом каждого запроса вкладки:
   сбой соединения или запрос, повисший без ответа, — кандидат на смену маршрута.
   Прежние «попутные домены» предлагали ВСЁ, что страница подгрузила, — на сайте MSI это
   был YouTube из встроенного видео. Теперь только то, что реально сломалось.

   Только наблюдаем (webRequest без блокировки), содержимое не читаем. Данные живут в
   памяти работника; сводка сбоев дублируется в storage.session, чтобы пережить засыпание
   service worker (MV3 гасит его, когда захочет). */
if (typeof self.NovpnFailures === 'undefined' && typeof importScripts === 'function') {
  importScripts('failures.js'); // Chrome/Edge: service worker. Firefox грузит его сам (background.scripts).
}
const F = self.NovpnFailures;

const inflight = new Map(); // requestId -> {tabId, host, type, start, headers}
const tabFailures = new Map(); // tabId -> {[base]: {n, reasons, main}}
const routeBadge = new Map(); // tabId -> 'VPN' | '' — маршрут сайта для значка
const hungTimers = new Map(); // tabId -> таймер перепроверки «зависших»

const sessionKey = (tabId) => `fail:${tabId}`;
const saveTimers = new Map();
function persist(tabId) {
  clearTimeout(saveTimers.get(tabId));
  saveTimers.set(
    tabId,
    setTimeout(() => {
      saveTimers.delete(tabId);
      const area = chrome.storage && chrome.storage.session;
      if (!area) return;
      const f = tabFailures.get(tabId);
      if (f && Object.keys(f).length) void area.set({ [sessionKey(tabId)]: f });
      else void area.remove(sessionKey(tabId));
    }, 300),
  );
}

async function failuresOf(tabId) {
  let f = tabFailures.get(tabId);
  if (f) return f;
  // Работник мог уснуть и проснуться — подтягиваем записанное до сна.
  const area = chrome.storage && chrome.storage.session;
  const saved = area ? ((await area.get(sessionKey(tabId)).catch(() => ({}))) || {})[sessionKey(tabId)] : null;
  f = tabFailures.get(tabId) || (saved && typeof saved === 'object' ? saved : {});
  tabFailures.set(tabId, f);
  return f;
}

function resetTab(tabId) {
  tabFailures.set(tabId, {});
  for (const [id, r] of inflight) if (r.tabId === tabId) inflight.delete(id);
  persist(tabId);
  void applyBadge(tabId);
}

function inflightOf(tabId) {
  const out = [];
  for (const r of inflight.values()) if (r.tabId === tabId) out.push(r);
  return out;
}

async function summaryFor(tabId, domain) {
  return F.summarize(await failuresOf(tabId), inflightOf(tabId), Date.now(), domain, 10);
}

/** Перепроверить «зависшие» чуть позже порога: сами они событий не порождают. */
function scheduleHungCheck(tabId) {
  if (hungTimers.has(tabId)) return;
  hungTimers.set(
    tabId,
    setTimeout(() => {
      hungTimers.delete(tabId);
      void applyBadge(tabId);
    }, F.HUNG_MS + 300),
  );
}

const FILTER = { urls: ['<all_urls>'] };

chrome.webRequest.onBeforeRequest.addListener((d) => {
  if (d.tabId < 0) return;
  // Новая загрузка страницы — прошлые сбои к ней уже не относятся (после смены маршрута
  // вкладка перезагружается, и список честно начинается с нуля).
  if (d.type === 'main_frame') resetTab(d.tabId);
  const host = F.hostOf(d.url);
  if (!host) return;
  inflight.set(d.requestId, { tabId: d.tabId, host, type: d.type, start: d.timeStamp || Date.now(), headers: false });
  scheduleHungCheck(d.tabId);
}, FILTER);

chrome.webRequest.onHeadersReceived.addListener((d) => {
  const r = inflight.get(d.requestId);
  if (!r) return;
  r.headers = true; // сервер ответил — дальше это не «висит», даже если тело долгое
  // Ответил, но отказом, похожим на блокировку (403 у самой страницы, 451 у чего угодно):
  // так гео-блок встречает ChatGPT — сетевой ошибки нет, а сайт не работает.
  const reason = F.httpReason(d.type, d.statusCode);
  if (reason) noteFailure(r, reason, d.type === 'main_frame');
}, FILTER);

chrome.webRequest.onBeforeRedirect.addListener((d) => {
  const r = inflight.get(d.requestId);
  if (!r) return;
  const host = F.hostOf(d.redirectUrl);
  if (!host) {
    inflight.delete(d.requestId);
    return;
  }
  // Редирект — тот же requestId, но новый адрес и новое ожидание ответа.
  Object.assign(r, { host, headers: false, start: d.timeStamp || Date.now() });
}, FILTER);

chrome.webRequest.onCompleted.addListener((d) => {
  const r = inflight.get(d.requestId);
  inflight.delete(d.requestId);
  // Повисший, но в итоге дозагрузившийся — не сбой; значок мог его уже учитывать.
  if (r && F.hungReason(r, Date.now())) void applyBadge(r.tabId);
}, FILTER);

chrome.webRequest.onErrorOccurred.addListener((d) => {
  const r = inflight.get(d.requestId);
  inflight.delete(d.requestId);
  // Только запросы ТЕКУЩЕЙ страницы. Запросы прошлой (видео YouTube, картинки Discord)
  // отваливаются уже после перехода — и приписывались новому сайту: живой прогон
  // показывал googlevideo на x.com. Их нет в inflight: он очищен при навигации.
  if (!r) return;
  let reason = F.classify(d.error);
  // Отмену (ERR_ABORTED) сбоем не считаем — кроме случая, когда запрос до этого висел
  // без ответа: страница устала ждать и бросила его. Так делает и ZeroOmega.
  if (!reason && /ABORT/i.test(d.error || '')) reason = F.hungReason(r, Date.now());
  if (reason) noteFailure(r, reason, d.type === 'main_frame');
}, FILTER);

function noteFailure(r, reason, main) {
  if (F.isNoise(r.host)) return;
  void failuresOf(r.tabId).then((f) => {
    F.record(f, r.host, reason, main);
    persist(r.tabId);
    void applyBadge(r.tabId);
  });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  tabFailures.delete(tabId);
  routeBadge.delete(tabId);
  for (const [id, r] of inflight) if (r.tabId === tabId) inflight.delete(id);
  const area = chrome.storage && chrome.storage.session;
  if (area) void area.remove(sessionKey(tabId));
});

/** Значок: число доменов, которые не загрузились (янтарный) — это важнее всего; иначе
    маршрут сайта («VPN» синим или пусто). Без открытия окна видно, что что-то не так. */
async function applyBadge(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return;
    const domain = domainOf(tab.url || '');
    const n = domain ? (await summaryFor(tabId, domain)).length : 0;
    if (n > 0) {
      await chrome.action.setBadgeText({ tabId, text: String(n) });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#D9822B' });
      await chrome.action.setTitle({ tabId, title: `NoVPN — на странице не загрузилось: ${n}. Нажмите, чтобы выбрать маршрут.` });
    } else {
      await chrome.action.setBadgeText({ tabId, text: routeBadge.get(tabId) || '' });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#0D7DD4' });
      await chrome.action.setTitle({ tabId, title: 'NoVPN' });
    }
  } catch {
    /* вкладку закрыли на лету — не важно */
  }
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
    // Запись правила ждёт, пока приложение применит его в движке (до 6 с), — ей больше.
    const writes = message && ['set', 'set_many', 'remove'].includes(message.type);
    setTimeout(() => finish({ ok: false, error: 'Приложение NoVPN не отвечает' }), writes ? 9000 : 4000);
    try {
      port.postMessage(message);
    } catch (e) {
      finish({ ok: false, error: 'Не удалось передать запрос' });
    }
  });
}

chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
  // Сбои страницы отвечаем сами — это память работника, приложение тут не нужно.
  if (req && req.type === 'failures') {
    summaryFor(Number(req.tabId), String(req.domain || ''))
      .then((items) => {
        sendResponse({ ok: true, items });
        // Сверяем значок с тем, что видит окно: повисший запрос мог дозагрузиться
        // без события, которое перерисовало бы значок (живой прогон: «2» при одном сбое).
        void applyBadge(Number(req.tabId));
      })
      .catch(() => sendResponse({ ok: true, items: [] }));
    return true;
  }
  if (req && req.type === 'badge') {
    void applyBadge(Number(req.tabId));
    sendResponse({ ok: true });
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
    routeBadge.set(tabId, '');
    await applyBadge(tabId);
    return;
  }
  const r = await ask({ type: 'get', domain });
  const route = r && r.ok ? r.route : null;
  routeBadge.set(tabId, route === 'vpn' ? 'VPN' : '');
  await applyBadge(tabId);
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
