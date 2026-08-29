// Публичная страница «Скачать» (/download). NoVPN для Windows — герой страницы
// (иконка + кнопка + инструкция), ниже — расширение для браузера. Самодостаточный HTML
// (как страница подписки/гайда): рендерит backend, работает без SPA.

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const normUrl = (u: string): string => (/^https?:\/\//i.test(u.trim()) ? u.trim() : `https://${u.trim()}`);

export function renderDownloadPage(opts: {
  appName: string;
  version: string | null;
  extChromeUrl?: string;
  extEdgeUrl?: string;
  extYandexUrl?: string;
  extFirefoxUrl?: string;
}): string {
  const { appName, version } = opts;
  const chrome = (opts.extChromeUrl ?? '').trim();
  const edge = (opts.extEdgeUrl ?? '').trim() || chrome; // Chromium → наследует Chrome-ссылку
  const yandex = (opts.extYandexUrl ?? '').trim() || chrome; // Chromium → наследует Chrome-ссылку
  const firefox = (opts.extFirefoxUrl ?? '').trim();

  const browserBtn = (label: string, url: string): string =>
    url
      ? `<a class="bbtn" href="${esc(normUrl(url))}" target="_blank" rel="noopener">${esc(label)}</a>`
      : `<span class="bbtn off">${esc(label)}<em>скоро</em></span>`;

  const browsers = [
    browserBtn('Chrome', chrome),
    browserBtn('Edge', edge),
    browserBtn('Яндекс', yandex),
    browserBtn('Firefox', firefox),
  ].join('');

  return `<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(appName)} — скачать</title>
<style>
  :root{--bg:#0f1115;--card:#171a21;--card2:#1e222b;--tx:#e8eaed;--mut:#9aa1ad;--acc:#4c8dff;--bd:#272c36;--r:16px}
  @media (prefers-color-scheme: light){:root{--bg:#f4f5f7;--card:#fff;--card2:#f0f2f5;--tx:#14161a;--mut:#5b6470;--bd:#e2e5ea}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--tx);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:32px 16px 64px}
  .wrap{max-width:600px;margin:0 auto}
  h1{font-size:24px;margin:0 0 6px}
  .lead{color:var(--mut);margin:0 0 26px}
  .hero{display:flex;gap:18px;align-items:center;background:var(--card);border:1px solid var(--bd);
        border-radius:var(--r);padding:22px;position:relative;overflow:hidden}
  .hero::before{content:"";position:absolute;inset:0;background:radial-gradient(120% 100% at 0% 0%,rgba(76,141,255,.14),transparent 60%);pointer-events:none}
  .ico{width:76px;height:76px;border-radius:18px;flex:none;object-fit:cover;position:relative}
  .hb{position:relative;min-width:0}
  .badge{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;
         color:var(--acc);background:rgba(76,141,255,.12);border-radius:999px;padding:3px 9px;margin-bottom:8px}
  .htitle{font-size:20px;font-weight:700}
  .hsub{color:var(--mut);font-size:14px;margin-top:2px}
  .row{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px;align-items:center}
  .btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;border:0;border-radius:12px;
       padding:12px 20px;font-size:15px;font-weight:600;cursor:pointer;text-decoration:none;white-space:nowrap}
  .btn-primary{background:var(--acc);color:#fff}
  .btn-ghost{background:transparent;color:var(--acc)}
  .ver{color:var(--mut);font-size:13px}
  h2{font-size:17px;margin:34px 0 4px}
  .note{color:var(--mut);font-size:13px;margin:0 0 14px}
  .browsers{display:flex;gap:10px;flex-wrap:wrap}
  .bbtn{display:inline-flex;align-items:center;gap:8px;background:var(--card);border:1px solid var(--bd);
        border-radius:12px;padding:11px 16px;font-size:14px;font-weight:600;color:var(--tx);text-decoration:none}
  .bbtn.off{color:var(--mut);cursor:default}
  .tshoot{margin-top:26px;background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:12px 16px}
  .tshoot summary{cursor:pointer;font-weight:600}
  .tshoot p{margin:10px 0;font-size:14px;color:var(--mut)}
  .tshoot a{color:var(--acc)}
  .tshoot ol{margin:10px 0;padding-left:22px;font-size:14px;color:var(--mut)}
  .tshoot li{margin:7px 0}
  .tshoot b{color:var(--tx)}
  .tshoot+.tshoot{margin-top:10px}
  .path{display:inline-flex;align-items:center;gap:8px;margin-top:6px;flex-wrap:wrap}
  .path code{background:var(--card2);padding:4px 9px;border-radius:7px;font-size:13px}
  .cp{background:var(--card2);color:var(--acc);border:1px solid var(--bd);border-radius:7px;
      padding:4px 10px;font-size:12px;cursor:pointer;font-family:inherit}
  .bbtn em{font-style:normal;font-size:11px;color:var(--mut);background:var(--card2);border-radius:6px;padding:1px 6px}
</style></head><body>
<div class="wrap">
  <h1>${esc(appName)}</h1>
  <p class="lead">Умный VPN для компьютера: через VPN идёт только нужное, остальное — напрямую.</p>

  <div class="hero">
    <img class="ico" src="/desktop/novpn-icon.png" alt="">
    <div class="hb">
      <span class="badge">Рекомендуем — основное приложение</span>
      <div class="htitle">NoVPN для Windows</div>
      <div class="hsub">Установка без прав администратора. Подписка любого провайдера.</div>
      <div class="row">
        <a class="btn btn-primary" href="/desktop/novpn.exe">⬇ Скачать для Windows</a>
        <a class="btn btn-ghost" href="/guide/novpn-desktop" target="_blank" rel="noopener">📖 Инструкция</a>
        ${version ? `<span class="ver">Версия ${esc(version)}</span>` : ''}
      </div>
    </div>
  </div>

  <details class="tshoot">
    <summary>Windows не даёт установить или удаляет файл</summary>
    <p>
      <b>Почему так.</b> Приложение пока не подписано платным сертификатом издателя, и его
      скачали немного людей — репутации у файла нет. Windows смотрит не на содержимое, а на
      поведение: программа прописывается в автозапуск и создаёт задачу, чтобы включаться
      вместе с системой. Для встроенной защиты это признак «закрепления в системе», и она
      блокирует файл на всякий случай. Отсюда «не удалось удалить» и «невозможно открыть
      файл для записи»: файл уже заблокирован, его нельзя ни перезаписать, ни стереть.
    </p>
    <p><b>Что сделать — по шагам (Windows 11):</b></p>
    <ol>
      <li>«Параметры» &rarr; <b>Конфиденциальность и защита</b> &rarr; <b>Безопасность Windows</b>.</li>
      <li>Открыть <b>Защита от вирусов и угроз</b>.</li>
      <li>Если файл уже удалили: <b>Журнал защиты</b> &rarr; найти запись про NoVPN &rarr;
        «Действия» &rarr; <b>Разрешить на устройстве</b>.</li>
      <li>Пролистать вниз до <b>Параметры защиты от вирусов и других угроз</b> &rarr;
        <b>Управление настройками</b>.</li>
      <li>Пролистать в самый низ до <b>Исключения</b> &rarr; <b>Добавление или удаление исключений</b>.</li>
      <li><b>Добавить исключение</b> &rarr; <b>Папка</b>.</li>
      <li>В строку адреса сверху вставить путь, нажать Enter, затем <b>Выбор папки</b>:
        <span class="path"><code id="excl">%LOCALAPPDATA%\\NoVPN</code><button class="cp" onclick="navigator.clipboard.writeText(document.getElementById('excl').textContent);this.textContent='Скопировано'">Копировать</button></span>
      </li>
      <li>Запустить установщик заново.</li>
    </ol>
    <p>
      Шаг с исключением нужен обязательно: без него защита может удалить файл снова через
      несколько минут. Подпись издателя снимет этот вопрос совсем — она в планах.
    </p>
  </details>

  <details class="tshoot">
    <summary>Установщик пишет «не удалось» или «невозможно открыть файл для записи»</summary>
    <p>
      Сначала проверьте предыдущий пункт — чаще всего дело именно в защите Windows.
      Если она ни при чём, причин обычно две.
    </p>
    <p>
      <b>Приложение запущено.</b> Закройте его через значок в трее (правая кнопка &rarr;
      «Выход») и запустите установщик снова: открытые файлы перезаписать нельзя.
    </p>
    <p>
      <b>Нет системного компонента.</b> Приложению нужен <b>Microsoft Edge WebView2
      Runtime</b>. На Windows 10 и 11 он есть изначально, но удаляется вместе с браузером
      или «чистилкой» системы. Поставьте его с сайта Microsoft и повторите установку:
      <a href="https://developer.microsoft.com/microsoft-edge/webview2/" target="_blank" rel="noopener">developer.microsoft.com/microsoft-edge/webview2</a>
      (раздел «Evergreen Standalone Installer», разрядка x64).
    </p>
  </details>

  <h2>Расширение для браузера</h2>
  <p class="note">Расширению нужно установленное приложение NoVPN для Windows.</p>
  <div class="browsers">${browsers}</div>

  <details class="tshoot">
    <summary>Магазин пишет «не найдено»? Поставьте вручную — это пара минут</summary>
    <p>
      Расширение ещё проходит проверку в магазинах. Пока его можно поставить из файла —
      браузер это умеет и без магазина.
    </p>
    <p><b>Chrome, Edge, Яндекс Браузер:</b></p>
    <ol>
      <li>Скачать архив: <a href="/extension/novpn-extension-chrome.zip">novpn-extension-chrome.zip</a>
        и распаковать в постоянную папку — если её удалить, расширение пропадёт.</li>
      <li>Открыть страницу расширений: <code>chrome://extensions</code> (в Edge —
        <code>edge://extensions</code>, в Яндексе — <code>browser://tune</code> &rarr; «Расширения»).</li>
      <li>Включить <b>Режим разработчика</b> — переключатель справа сверху.</li>
      <li>Нажать <b>Загрузить распакованное расширение</b> и выбрать распакованную папку.</li>
      <li>Значок появится на панели. Приложение NoVPN должно быть запущено.</li>
    </ol>
    <p><b>Firefox:</b></p>
    <ol>
      <li>Скачать <a href="/extension/novpn-extension-firefox.zip">novpn-extension-firefox.zip</a>.</li>
      <li>Открыть <code>about:debugging#/runtime/this-firefox</code>.</li>
      <li>Нажать <b>Загрузить временное дополнение</b> и выбрать скачанный файл.</li>
      <li>Firefox снимает такие дополнения при перезапуске — до публикации в каталоге это
        нормально.</li>
    </ol>
  </details>
</div>
</body></html>`;
}
