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
let tabId = null;

/* Попутные домены. После выбора маршрута спрашиваем фон, какие сторонние домены
   подгружала вкладка, и предлагаем отправить их тем же путём. Молча ничего не
   добавляем: человек видит список, снимает лишнее и подтверждает. */
const ROUTE_WORD = { vpn: 'через VPN', direct: 'напрямую' };

function hideRelated() {
  $('related').hidden = true;
  $('related-list').textContent = '';
}

async function suggestRelated(route) {
  hideRelated();
  if (tabId == null) return;
  const r = await send({ type: 'related', tabId, domain });
  const items = r && r.ok ? r.items : [];
  if (!items.length) return;

  $('related-title').textContent = `Этот сайт подгружает ещё ${items.length === 1 ? 'один домен' : `${items.length} домена`} — отправить ${ROUTE_WORD[route]} тоже?`;
  const list = $('related-list');
  for (const it of items) {
    const li = document.createElement('li');
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.dataset.domain = it.domain;
    const text = document.createElement('span');
    text.textContent = it.domain;
    const hits = document.createElement('small');
    hits.textContent = `${it.hits}`;
    hits.title = 'сколько запросов ушло на этот домен';
    label.append(cb, text, hits);
    li.append(label);
    list.append(li);
  }
  const apply = $('related-apply');
  apply.textContent = `Отправить ${ROUTE_WORD[route]}`;
  apply.onclick = async () => {
    const picked = [...list.querySelectorAll('input:checked')].map((c) => c.dataset.domain);
    apply.disabled = true;
    let ok = 0;
    for (const d of picked) {
      const res = await send({ type: 'set', domain: d, route });
      if (res && res.ok) ok += 1;
    }
    apply.disabled = false;
    hideRelated();
    note(ok ? `Готово: ещё ${ok} ${ok === 1 ? 'домен' : 'домена'} ${ROUTE_WORD[route]}.` : 'Ничего не добавлено.', !ok);
  };
  $('related').hidden = false;
}

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
  tabId = tab && typeof tab.id === 'number' ? tab.id : null;

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
    void suggestRelated(route);
  });
});

$('related-skip').addEventListener('click', hideRelated);

$('clear').addEventListener('click', async () => {
  if (!domain) return;
  hideRelated();
  paintRoute(null, null);
  const r = await send({ type: 'remove', domain });
  if (!r || !r.ok) {
    note(r && r.error ? r.error : 'Не удалось убрать правило', true);
    return;
  }
  note('Правило убрано.');
});

void init();
