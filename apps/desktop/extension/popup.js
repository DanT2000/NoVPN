/* Окно расширения: показывает домен открытой вкладки и его маршрут,
   позволяет переключить одним нажатием. */

const $ = (id) => document.getElementById(id);

function domainOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

const send = (msg) => chrome.runtime.sendMessage(msg);

let domain = null;

function paintRoute(route, source) {
  document.querySelectorAll('.choice').forEach((b) => {
    b.setAttribute('aria-checked', String(b.dataset.route === route));
  });
  $('clear').hidden = !route;
  $('source').textContent = !route
    ? 'Правила нет — идёт напрямую'
    : source === 'list'
      ? 'Из готового списка'
      : 'Ваше правило';
}

function note(text, warn) {
  const el = $('note');
  el.textContent = text || '';
  el.classList.toggle('warn', Boolean(warn));
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  domain = tab && tab.url ? domainOf(tab.url) : null;

  if (!domain) {
    document.body.classList.add('blocked');
    $('domain').textContent = 'Не сайт';
    note('Откройте обычную страницу — служебные вкладки маршрутизировать нечем.');
    return;
  }

  $('domain').textContent = domain;
  $('avatar').textContent = domain.charAt(0).toUpperCase();

  const status = await send({ type: 'status' });
  if (!status || !status.ok) {
    document.body.classList.add('blocked');
    note(status && status.error ? status.error : 'Приложение NoVPN не запущено', true);
    return;
  }
  $('conn').textContent = status.connected ? 'подключено' : 'выключено';
  $('conn').classList.toggle('on', Boolean(status.connected));
  if (!status.connected) {
    note('Правило сохранится, но заработает после запуска подключения в приложении.');
  }

  const r = await send({ type: 'get', domain });
  if (r && r.ok) paintRoute(r.route, r.source);
}

document.querySelectorAll('.choice').forEach((btn) => {
  btn.addEventListener('click', async () => {
    if (!domain) return;
    const route = btn.dataset.route;
    paintRoute(route, 'manual');
    const r = await send({ type: 'set', domain, route });
    if (!r || !r.ok) {
      note(r && r.error ? r.error : 'Не удалось сохранить правило', true);
      return;
    }
    note('Готово. Правило уже действует.');
  });
});

$('clear').addEventListener('click', async () => {
  if (!domain) return;
  paintRoute(null, null);
  const r = await send({ type: 'remove', domain });
  if (!r || !r.ok) {
    note(r && r.error ? r.error : 'Не удалось убрать правило', true);
    return;
  }
  note('Правило убрано.');
});

void init();
