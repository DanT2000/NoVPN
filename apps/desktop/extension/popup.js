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

/* Перезагрузка активной вкладки после смены маршрута. Как в SwitchyOmega/Omega Proxy:
   уже открытая страница держит соединения по СТАРОМУ маршруту, и правило начинает
   действовать только на новых запросах — поэтому сразу перезагружаем, чтобы «нажал →
   через VPN → страница мгновенно переоткрылась уже по новому пути». Право tabs в манифесте. */
function reloadTab() {
  if (tabId != null) {
    try {
      chrome.tabs.reload(tabId, { bypassCache: false });
    } catch {
      /* вкладку могли закрыть — не критично */
    }
  }
}

/* Что на странице НЕ загрузилось. Фон следит за исходом каждого запроса вкладки (как
   ZeroOmega) и отдаёт только реальные сбои: сброс, нет ответа, адрес не найден, завис.
   Окно показывает их вживую, пока открыто, — после смены маршрута вкладка
   перезагружается, и видно, помогло ли. Молча ничего не добавляем: человек видит список,
   снимает лишнее и сам выбирает маршрут. */
const ROUTE_WORD = { vpn: 'через VPN', direct: 'напрямую' };
const ROUTE_TAG = { vpn: 'VPN', direct: 'напрямую' };
const unchecked = new Set(); // что человек снял — не отмечаем заново при обновлении
const routeOf = new Map(); // домен -> маршрут в приложении (узнаём один раз)
let failPoll = null;
let applying = false;

function plural(n, one, few, many) {
  const a = n % 10;
  const b = n % 100;
  if (a === 1 && b !== 11) return one;
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;
  return many;
}

async function lookupRoutes(items) {
  const todo = items.map((it) => it.domain).filter((d) => !routeOf.has(d));
  for (const d of todo) routeOf.set(d, null); // не спрашиваем повторно, пока ждём
  await Promise.all(
    todo.map(async (d) => {
      const r = await send({ type: 'get', domain: d });
      routeOf.set(d, r && r.ok ? r.route || 'none' : 'none');
    }),
  );
}

function renderFailures(items) {
  const box = $('fail');
  const ok = $('fail-ok');
  if (!items.length) {
    box.hidden = true;
    ok.hidden = false;
    return;
  }
  ok.hidden = true;
  $('fail-title').textContent = `На странице не ${plural(items.length, 'загрузился', 'загрузились', 'загрузились')} ${items.length} ${plural(items.length, 'домен', 'домена', 'доменов')}:`;
  const list = $('fail-list');
  list.textContent = '';
  for (const it of items) {
    const li = document.createElement('li');
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !unchecked.has(it.domain);
    cb.dataset.domain = it.domain;
    cb.addEventListener('change', () => {
      if (cb.checked) unchecked.delete(it.domain);
      else unchecked.add(it.domain);
    });
    const main = document.createElement('span');
    main.className = 'fail-main';
    const name = document.createElement('span');
    name.className = 'fail-domain';
    name.textContent = it.domain + (it.self ? ' · сам сайт' : '');
    const why = document.createElement('span');
    why.className = 'fail-reason';
    why.textContent = it.reason + (it.count > 1 ? ` · ${it.count}` : '');
    main.append(name, why);
    const tag = document.createElement('small');
    const r = routeOf.get(it.domain);
    tag.className = 'fail-route';
    tag.textContent = r === 'vpn' || r === 'direct' ? ROUTE_TAG[r] : '';
    tag.title = r === 'vpn' || r === 'direct' ? `Сейчас: ${ROUTE_WORD[r]}` : 'Правила нет — идёт напрямую';
    label.append(cb, main, tag);
    li.append(label);
    list.append(li);
  }
  box.hidden = false;
}

async function refreshFailures() {
  if (tabId == null || !domain || applying) return;
  const r = await send({ type: 'failures', tabId, domain });
  const items = r && r.ok ? r.items : [];
  if (items.some((it) => !routeOf.has(it.domain))) await lookupRoutes(items);
  if (!applying) renderFailures(items);
}

function startFailures() {
  void refreshFailures();
  clearInterval(failPoll);
  failPoll = setInterval(() => void refreshFailures(), 1500);
}

async function applyFailures(route) {
  const picked = [...$('fail-list').querySelectorAll('input:checked')].map((c) => c.dataset.domain);
  if (!picked.length) {
    note('Отметьте хотя бы один домен.', true);
    return;
  }
  applying = true;
  $('fail-vpn').disabled = true;
  $('fail-direct').disabled = true;
  let done = 0;
  for (const d of picked) {
    const res = await send({ type: 'set', domain: d, route });
    if (res && res.ok) {
      done += 1;
      routeOf.set(d, route);
    }
  }
  $('fail-vpn').disabled = false;
  $('fail-direct').disabled = false;
  applying = false;
  if (!done) {
    note('Не удалось сохранить правила.', true);
    return;
  }
  if (picked.includes(domain)) paintRoute(route, 'manual');
  note(`Готово: ${done} ${plural(done, 'домен', 'домена', 'доменов')} ${ROUTE_WORD[route]} — страница перезагружается.`);
  reloadTab(); // новый маршрут действует на новых запросах — переоткрываем страницу
}

$('fail-vpn').addEventListener('click', () => void applyFailures('vpn'));
$('fail-direct').addEventListener('click', () => void applyFailures('direct'));

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
  if (r && r.ok) {
    paintRoute(r.route, r.source);
    routeOf.set(domain, r.route || 'none');
  }
  startFailures();
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
    routeOf.set(domain, route);
    note('Готово — страница перезагружается по новому маршруту.');
    reloadTab(); // мгновенный эффект, как в SwitchyOmega; список сбоев обновится сам
  });
});

$('clear').addEventListener('click', async () => {
  if (!domain) return;
  paintRoute(null, null);
  routeOf.set(domain, 'none');
  const r = await send({ type: 'remove', domain });
  if (!r || !r.ok) {
    note(r && r.error ? r.error : 'Не удалось убрать правило', true);
    return;
  }
  note('Правило убрано — страница перезагружается.');
  reloadTab(); // вернулись к прямому маршруту — тоже переоткрываем страницу
});

void init();
