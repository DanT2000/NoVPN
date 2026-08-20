// Инструкции приложений: Markdown-гайды с картинками, открываются отдельной
// красивой страницей (/guide/<appId>). Ассеты лежат в apps/web/public/guides/<id>/
// (guide.md + images/…) → Vite копирует их в dist, панель отдаёт статикой; сам
// Markdown рендерим на бэкенде (marked) и оборачиваем в самодостаточную HTML-страницу.

import fs from 'node:fs';
import path from 'node:path';
import { marked } from 'marked';
import { config } from '../config.js';

/** Приложения, у которых есть гайд (id = id приложения в каталоге).
 *  mdRel — путь к Markdown относительно config.desktopDir; imgBase — публичный
 *  префикс, на который переписываются относительные пути картинок images/… */
export const GUIDES: Record<string, { title: string; mdRel: string; imgBase: string }> = {
  'novpn-desktop': {
    title: 'NoVPN для компьютера — инструкция',
    mdRel: 'guide/novpn-desktop-guide.md',
    imgBase: '/desktop/guide/images/',
  },
};

export const hasGuide = (appId: string): boolean => Object.prototype.hasOwnProperty.call(GUIDES, appId);

const esc = (s: string): string =>
  s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));

/** Слаг заголовка для якорей оглавления (совместим с GitHub-стилем ссылок в гайде). */
function slug(inner: string): string {
  return inner
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z0-9#]+;/gi, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]+/gu, '')
    .replace(/\s+/g, '-');
}

/** Отрендерить страницу инструкции. null → гайда нет или файл не найден. */
export function renderGuidePage(appId: string): string | null {
  if (!hasGuide(appId)) return null;
  const g = GUIDES[appId]!;
  const mdPath = path.join(config.desktopDir, g.mdRel);
  let md: string;
  try {
    md = fs.readFileSync(mdPath, 'utf8');
  } catch {
    return null;
  }
  // Относительные пути картинок images/… → публичный путь статики канала desktop.
  md = md.replace(/src="images\//g, `src="${g.imgBase}"`);
  let body = marked.parse(md, { async: false, gfm: true }) as string;
  // Проставить id заголовкам (для якорей оглавления).
  body = body.replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, (_m, lvl, inner) => `<h${lvl} id="${esc(slug(inner))}">${inner}</h${lvl}>`);
  return wrap(GUIDES[appId]!.title, body);
}

function wrap(title: string, body: string): string {
  return `<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title>
<style>
  :root{--bg:#0f1115;--card:#171a21;--tx:#e8eaed;--mut:#9aa1ad;--acc:#4c8dff;--bd:#272c36;--code:#1e222b}
  @media (prefers-color-scheme: light){:root{--bg:#f4f5f7;--card:#fff;--tx:#14161a;--mut:#5b6470;--bd:#e2e5ea;--code:#f0f2f5}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--tx);
       font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  .top{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--bg) 88%,transparent);
       backdrop-filter:blur(8px);border-bottom:1px solid var(--bd);padding:12px 16px}
  .top a{color:var(--acc);text-decoration:none;font-size:14px;font-weight:600}
  .wrap{max-width:760px;margin:0 auto;padding:24px 20px 64px}
  h1{font-size:28px;line-height:1.25;margin:8px 0 20px}
  h2{font-size:22px;margin:34px 0 12px;padding-top:8px;border-top:1px solid var(--bd)}
  h3{font-size:18px;margin:22px 0 8px}
  p{margin:12px 0}
  a{color:var(--acc)}
  ul,ol{margin:12px 0;padding-left:24px}
  li{margin:6px 0}
  img{max-width:100%;height:auto;border-radius:12px;border:1px solid var(--bd)}
  p[align="center"]{text-align:center}
  blockquote{margin:16px 0;padding:12px 16px;border-left:3px solid var(--acc);
             background:var(--card);border-radius:0 10px 10px 0;color:var(--mut)}
  blockquote p{margin:6px 0}
  blockquote strong{color:var(--tx)}
  code{background:var(--code);padding:2px 6px;border-radius:6px;font-size:.9em;
       font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  table{border-collapse:collapse;width:100%;margin:16px 0;font-size:15px;display:block;overflow-x:auto}
  th,td{border:1px solid var(--bd);padding:9px 12px;text-align:left;vertical-align:top}
  th{background:var(--card);font-weight:600}
  hr{border:0;border-top:1px solid var(--bd);margin:28px 0}
  sub{color:var(--mut)}
  h2:first-of-type{border-top:0}
</style></head><body>
<div class="top"><a href="javascript:history.length>1?history.back():window.close()">‹ Назад</a></div>
<div class="wrap">
${body}
</div>
</body></html>`;
}
