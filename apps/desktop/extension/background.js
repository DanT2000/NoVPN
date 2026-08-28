/* Связь с приложением NoVPN через нативные сообщения.

   Соединение делаем разовым на каждый запрос, а не постоянным. Постоянное
   держало бы процесс приложения привязанным к жизни служебного работника
   расширения, а тот в Manifest V3 засыпает когда захочет — получались бы
   висящие процессы и «отвалившийся» канал в самый нужный момент. */

const HOST = 'ru.appswire.novpn';

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
      finish({ ok: false, error: err ? 'Приложение NoVPN не отвечает' : 'Соединение закрыто' });
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
