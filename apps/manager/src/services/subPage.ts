// Страница подписки: тот же адрес /sub/<токен>, что и для VPN-приложения.
//
// Приложение получает base64-список конфигов, браузер — эту страницу. Так одна
// ссылка закрывает всё: человеку можно отправить её и не объяснять ничего —
// откроет в браузере и увидит, что ставить и куда нажимать; вставит в
// приложение — получит конфиги.
//
// Страница самодостаточная (без сборки фронтенда): её отдаёт backend, и она
// должна открываться, даже если SPA недоступна.

import type { AppClient, AppPlatform, User } from '@novpn/shared';

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** Ссылка «добавить подписку одним нажатием» — из схемы, заданной в каталоге.
 *  Схема либо оканчивается на '=' (параметр), либо на '/' — тогда просто дописываем. */
function oneTap(app: AppClient, subUrl: string): string | null {
  const sc = app.urlScheme;
  if (!sc) return null;
  return sc.endsWith('=') ? sc + encodeURIComponent(subUrl) : sc + subUrl;
}

function storeLabel(url: string): string {
  if (/play\.google\.com/i.test(url)) return 'Google Play';
  if (/apps\.apple\.com|itunes\.apple/i.test(url)) return 'App Store';
  if (/(microsoft\.com\/.*store|apps\.microsoft)/i.test(url)) return 'Microsoft Store';
  return 'Установить';
}

const PLATFORMS: AppPlatform[] = ['Android', 'iOS', 'Windows', 'macOS', 'Linux'];

export function renderSubPage(opts: {
  appName: string;
  user: User;
  subUrl: string;
  apps: AppClient[];
  /** Сколько конфигов сейчас в подписке. */
  configCount: number;
}): string {
  const { appName, user, subUrl, apps, configCount } = opts;

  // Только клиенты, умеющие Xray: подписка — это Xray.
  const xrayApps = apps.filter((a) => a.enabled && a.compat.includes('xray'));

  const cards = PLATFORMS.map((plat) => {
    const list = xrayApps
      .map((a) => ({ a, e: a.platforms.find((p) => p.platform === plat) }))
      .filter((x) => x.e);
    if (!list.length) return '';
    const items = list
      .map(({ a, e }) => {
        const tap = oneTap(a, subUrl);
        const icon = a.icon
          ? `<img class="ico" src="${esc(a.icon)}" alt="">`
          : `<div class="ico ph">${esc(a.client.slice(0, 1))}</div>`;
        const install = e!.url
          ? `<a class="btn btn-primary" href="${esc(e!.url)}" target="_blank" rel="noopener">${esc(storeLabel(e!.url))}</a>`
          : '';
        const add = tap
          ? `<a class="btn btn-sec" href="${esc(tap)}">Добавить подписку</a>`
          : `<button class="btn btn-sec" data-copy>Копировать ссылку</button>`;
        return `<div class="app">${icon}<div class="app-b"><div class="app-n">${esc(a.client)}</div>${
          a.instruction ? `<div class="app-i">${esc(a.instruction)}</div>` : ''
        }<div class="row">${install}${add}</div></div></div>`;
      })
      .join('');
    return `<section class="plat" data-plat="${esc(plat)}" hidden>${items}</section>`;
  }).join('');

  const tabs = PLATFORMS.filter((p) => xrayApps.some((a) => a.platforms.some((x) => x.platform === p)))
    .map((p) => `<button class="tab" data-tab="${esc(p)}">${esc(p)}</button>`)
    .join('');

  const expiry = user.expiresAt
    ? new Date(user.expiresAt).toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' })
    : 'бессрочно';
  const traffic =
    user.trafficLimitGb != null
      ? `${(user.trafficUsedGb ?? 0).toFixed(1)} из ${user.trafficLimitGb} ГБ`
      : `${(user.trafficUsedGb ?? 0).toFixed(1)} ГБ`;

  return `<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>${esc(appName)} — подключение</title>
<style>
  :root{--bg:#0f1115;--card:#171a21;--card2:#1e222b;--tx:#e8eaed;--mut:#9aa1ad;--acc:#4c8dff;--bd:#272c36;--r:14px}
  @media (prefers-color-scheme: light){:root{--bg:#f4f5f7;--card:#fff;--card2:#f0f2f5;--tx:#14161a;--mut:#666e7a;--bd:#e2e5ea}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
       padding:20px 16px 48px}
  .wrap{max-width:460px;margin:0 auto}
  h1{font-size:22px;margin:0 0 4px}
  .sub{color:var(--mut);font-size:14px;margin:0 0 20px}
  .card{background:var(--card);border:1px solid var(--bd);border-radius:var(--r);padding:16px;margin-bottom:14px}
  .lbl{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--mut);margin-bottom:8px}
  .link{width:100%;background:var(--card2);border:1px solid var(--bd);border-radius:10px;padding:10px;
        font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--tx);word-break:break-all}
  .btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:0;border-radius:10px;
       padding:9px 14px;font-size:14px;font-weight:600;cursor:pointer;text-decoration:none;white-space:nowrap}
  .btn-primary{background:var(--acc);color:#fff}
  .btn-sec{background:var(--card2);color:var(--tx);border:1px solid var(--bd)}
  .btn-wide{width:100%;margin-top:10px;padding:12px}
  .row{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
  .meta{display:flex;gap:18px;flex-wrap:wrap;color:var(--mut);font-size:13px;margin-top:10px}
  .meta b{color:var(--tx);font-weight:600}
  .tabs{display:flex;gap:6px;overflow-x:auto;margin:22px 0 12px;padding-bottom:4px}
  .tab{background:var(--card);border:1px solid var(--bd);color:var(--mut);border-radius:999px;
       padding:7px 14px;font-size:13px;cursor:pointer;white-space:nowrap}
  .tab.on{background:var(--acc);border-color:var(--acc);color:#fff}
  .app{display:flex;gap:12px;background:var(--card);border:1px solid var(--bd);border-radius:var(--r);
       padding:14px;margin-bottom:10px}
  .ico{width:44px;height:44px;border-radius:11px;flex:none;object-fit:cover}
  .ico.ph{background:var(--card2);display:flex;align-items:center;justify-content:center;font-weight:700}
  .app-b{min-width:0;flex:1}
  .app-n{font-weight:600}
  .app-i{color:var(--mut);font-size:13px;margin-top:2px}
  .step{color:var(--mut);font-size:13px;margin:18px 0 8px}
  .toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#000c;color:#fff;
         padding:10px 16px;border-radius:10px;font-size:14px;opacity:0;transition:opacity .2s;pointer-events:none}
  .toast.on{opacity:1}
</style></head><body>
<div class="wrap">
  <h1>${esc(appName)}</h1>
  <p class="sub">Подключение для «${esc(user.name)}»</p>

  <div class="card">
    <div class="lbl">Ссылка-подписка</div>
    <div class="link" id="lnk">${esc(subUrl)}</div>
    <button class="btn btn-primary btn-wide" data-copy>Скопировать ссылку</button>
    <div class="meta">
      <span>Конфигураций: <b>${configCount}</b></span>
      <span>Действует: <b>${esc(expiry)}</b></span>
      <span>Трафик: <b>${esc(traffic)}</b></span>
    </div>
  </div>

  ${
    configCount > 0
      ? `<div class="card">
    <div class="lbl">Подписка с обходом белых списков (V2RayNG)</div>
    <div class="app-i" style="margin-bottom:10px">Отдельная подписка: российские сайты (госуслуги, банки, VK, Яндекс, Ozon…) идут напрямую и работают даже в режиме «белого списка», остальное — через VPN. Добавьте этот адрес в V2RayNG как подписку — сервер и маршрутизация подгрузятся сами.</div>
    <div class="link" id="lnkfull">${esc(subUrl)}/full</div>
    <button class="btn btn-primary btn-wide" data-copy-full>Скопировать подписку с обходом</button>
    <a class="btn btn-sec btn-wide" style="margin-top:8px" href="${esc(subUrl)}/full" download="${esc(appName)}-whitelist.json">Скачать файлом (для импорта конфига)</a>
  </div>`
      : ''
  }

  <div class="step">Выберите вашу систему — покажем, что установить.</div>
  <div class="tabs">${tabs}</div>
  ${cards}
</div>
<div class="toast" id="t"></div>
<script>
  var SUB = ${JSON.stringify(subUrl)};
  function toast(m){var t=document.getElementById('t');t.textContent=m;t.className='toast on';
    setTimeout(function(){t.className='toast'},1800)}
  function copyText(txt,id){
    if(navigator.clipboard){navigator.clipboard.writeText(txt).then(function(){toast('Ссылка скопирована')},
      function(){toast('Скопируйте вручную')})}
    else{var el=document.getElementById(id);if(!el)return;var r=document.createRange();r.selectNode(el);
      var s=getSelection();s.removeAllRanges();s.addRange(r);
      try{document.execCommand('copy');toast('Ссылка скопирована')}catch(_){toast('Скопируйте вручную')}
      s.removeAllRanges()}
  }
  document.addEventListener('click',function(e){
    if(e.target.closest('[data-copy]')) return copyText(SUB,'lnk');
    if(e.target.closest('[data-copy-full]')) return copyText(SUB+'/full','lnkfull');
  });
  // Вкладка системы: по умолчанию — угаданная по устройству.
  var ua=navigator.userAgent, def=/android/i.test(ua)?'Android':/iphone|ipad|ipod/i.test(ua)?'iOS':
    /mac/i.test(ua)?'macOS':/linux/i.test(ua)?'Linux':'Windows';
  var tabs=[].slice.call(document.querySelectorAll('.tab'));
  function pick(p){
    tabs.forEach(function(t){t.classList.toggle('on',t.dataset.tab===p)});
    [].forEach.call(document.querySelectorAll('.plat'),function(s){s.hidden=s.dataset.plat!==p});
  }
  tabs.forEach(function(t){t.addEventListener('click',function(){pick(t.dataset.tab)})});
  pick(tabs.some(function(t){return t.dataset.tab===def})?def:(tabs[0]&&tabs[0].dataset.tab));
</script>
</body></html>`;
}
