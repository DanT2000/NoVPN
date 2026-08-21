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
  extFirefoxUrl?: string;
}): string {
  const { appName, version } = opts;
  const chrome = (opts.extChromeUrl ?? '').trim();
  const firefox = (opts.extFirefoxUrl ?? '').trim();

  const browserBtn = (label: string, url: string): string =>
    url
      ? `<a class="bbtn" href="${esc(normUrl(url))}" target="_blank" rel="noopener">${esc(label)}</a>`
      : `<span class="bbtn off">${esc(label)}<em>скоро</em></span>`;

  const browsers = [
    browserBtn('Chrome', chrome),
    browserBtn('Edge', chrome),
    browserBtn('Яндекс', chrome),
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

  <h2>Расширение для браузера</h2>
  <p class="note">Расширению нужно установленное приложение NoVPN для Windows.</p>
  <div class="browsers">${browsers}</div>
</div>
</body></html>`;
}
