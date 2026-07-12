// Telegram-бот: работает через прокси (прод в РФ не достаёт api.telegram.org напрямую).
// Умеет: привязка по 6-значному коду (/start <code> или просто код) и выдача конфига (/config).

import { ProxyAgent } from 'undici';
import * as repo from '../repo.js';
import { decryptSecret } from '../lib/crypto.js';
import { getServerProxy } from './keyvault.js';
import { issueForUser } from './issue.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function getToken(): string {
  const enc = repo.getTelegramTokenEnc();
  if (!enc) return '';
  try {
    return decryptSecret(enc);
  } catch {
    return '';
  }
}

/** URL прокси для запросов к Telegram (сервер или ручной). */
export function resolveTgProxyUrl(): string | null {
  const tg = repo.getTelegram();
  if (!tg?.proxyOn) return null;
  const enc = encodeURIComponent;
  if (tg.proxySource === 'server' && tg.proxyServerId) {
    const srv = repo.getServer(tg.proxyServerId);
    if (!srv) return null;
    const p = getServerProxy(srv.host);
    if (!p) return null;
    if (p.httpsPort && p.httpsHost) return `https://${enc(p.user)}:${enc(p.pass)}@${p.httpsHost}:${p.httpsPort}`;
    if (p.httpPort) return `http://${enc(p.user)}:${enc(p.pass)}@${srv.host}:${p.httpPort}`;
    return null;
  }
  if (tg.proxyHost && tg.proxyPort && (tg.proxyType === 'http' || tg.proxyType === 'https')) {
    const encPass = (tg as unknown as { proxyPassEnc?: string }).proxyPassEnc;
    const pass = encPass ? decryptSecret(encPass) : '';
    const authp = tg.proxyLogin ? `${enc(tg.proxyLogin)}:${enc(pass)}@` : '';
    return `${tg.proxyType}://${authp}${tg.proxyHost}:${tg.proxyPort}`;
  }
  return null;
}

/** Вызов Telegram Bot API через прокси. */
export async function tgApi<T = any>(method: string, params: Record<string, unknown> = {}, tokenOverride?: string): Promise<T> {
  const token = tokenOverride ?? getToken();
  if (!token) throw new Error('Токен бота не задан.');
  const proxyUrl = resolveTgProxyUrl();
  const waitS = typeof params.timeout === 'number' ? params.timeout : 0;
  const opts: RequestInit & { dispatcher?: ProxyAgent } = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout((waitS + 15) * 1000),
  };
  if (proxyUrl) opts.dispatcher = new ProxyAgent(proxyUrl);
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, opts);
  const d = (await r.json()) as { ok: boolean; result?: T; description?: string };
  if (!d.ok) throw new Error(d.description ?? 'Telegram error');
  return d.result as T;
}

// ── Бот (long-polling) ──
let running = false;
let offset = 0;
let loopId = 0;

function saveBotUsername(username: string | undefined): void {
  if (!username) return;
  const cur = repo.getTelegram();
  if ((cur as { botUsername?: string }).botUsername === username) return;
  repo.saveTelegramRaw({ ...cur, botUsername: username });
}

export function stopBot(): void {
  running = false;
  loopId += 1; // инвалидируем текущий цикл
}

export async function startBot(): Promise<void> {
  const tg = repo.getTelegram();
  if (!tg?.enabled || !getToken()) return;
  if (running) return;
  running = true;
  const myLoop = ++loopId;
  // Снимаем возможный webhook (иначе getUpdates даёт 409) и узнаём username.
  try {
    await tgApi('deleteWebhook', { drop_pending_updates: false });
    const me = await tgApi<{ username?: string }>('getMe');
    saveBotUsername(me.username);
  } catch {
    /* сеть/прокси недоступны — попробуем в цикле */
  }
  void pollLoop(myLoop);
}

export function restartBot(): void {
  stopBot();
  setTimeout(() => void startBot(), 800);
}

async function pollLoop(myLoop: number): Promise<void> {
  while (running && myLoop === loopId) {
    try {
      const updates = await tgApi<Array<Record<string, any>>>('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] });
      for (const u of updates) {
        offset = (u.update_id as number) + 1;
        try {
          await handleUpdate(u);
        } catch {
          /* один сбойный апдейт не должен ронять цикл */
        }
      }
    } catch {
      // Telegram/прокси недоступны — подождём и повторим.
      await sleep(8000);
    }
  }
}

async function send(chatId: number | string, text: string, markdown = false): Promise<void> {
  try {
    await tgApi('sendMessage', { chat_id: chatId, text, ...(markdown ? { parse_mode: 'Markdown' } : {}), disable_web_page_preview: true });
  } catch {
    /* игнор */
  }
}

/** Идентификатор пользователя Telegram для привязки. */
function handleOf(from: Record<string, any>, chatId: number): string {
  return from?.username ? `@${from.username}` : `id:${chatId}`;
}

async function handleUpdate(u: Record<string, any>): Promise<void> {
  const msg = u.message ?? u.edited_message;
  if (!msg || typeof msg.text !== 'string') return;
  const chatId = msg.chat.id as number;
  const text = (msg.text as string).trim();
  const handle = handleOf(msg.from ?? {}, chatId);

  if (text === '/config' || /получить конфиг|выпустить конфиг/i.test(text)) {
    await issueViaBot(chatId, handle);
    return;
  }

  let code = '';
  if (text.startsWith('/start')) {
    code = text.replace('/start', '').trim();
    if (!code) {
      await send(chatId, 'Привет! Отправьте ваш 6-значный код доступа, чтобы привязать Telegram и получать конфигурации.');
      return;
    }
  } else if (/^\d{6}$/.test(text)) {
    code = text;
  } else {
    await send(chatId, 'Отправьте ваш 6-значный код доступа, или /start, или /config.');
    return;
  }

  if (!/^\d{6}$/.test(code)) {
    await send(chatId, 'Код должен состоять из 6 цифр. Попробуйте ещё раз.');
    return;
  }
  const user = repo.getUserByCode(code);
  if (!user) {
    await send(chatId, 'Код не найден. Проверьте код и отправьте снова.');
    return;
  }
  repo.updateUserFields(user.id, { telegram: handle });
  repo.addHistory(user.id, `Привязан Telegram: ${handle}`);
  await send(chatId, `Готово, ${user.name}! Telegram привязан.\nОтправьте /config, чтобы получить конфигурацию.`);
}

async function issueViaBot(chatId: number, handle: string): Promise<void> {
  const user = repo.listUsers().find((u) => u.telegram === handle);
  if (!user) {
    await send(chatId, 'Сначала привяжите Telegram — отправьте ваш 6-значный код доступа.');
    return;
  }
  if (!user.isActive) {
    await send(chatId, 'Доступ отключён администратором.');
    return;
  }
  if (user.expiresAt && new Date(user.expiresAt) < new Date()) {
    await send(chatId, 'Срок действия доступа истёк. Обратитесь к администратору.');
    return;
  }
  const serverId = user.defaultServerId || user.allowedServers[0];
  const protocol = (user.allowedProtocols.find((p) => p === 'xray' || p === 'amneziawg') ?? 'xray') as 'xray' | 'amneziawg';
  if (!serverId) {
    await send(chatId, 'Для вашего доступа не назначен сервер. Обратитесь к администратору.');
    return;
  }
  await send(chatId, 'Выпускаю конфигурацию…');
  try {
    const out = await issueForUser(user, 'Telegram', serverId, protocol);
    const cfg = out.link ?? out.conf ?? '';
    await send(chatId, `Ваша конфигурация (${protocol === 'xray' ? 'Xray' : 'AmneziaWG'}):`);
    await send(chatId, '```\n' + cfg + '\n```', true);
    await send(chatId, 'Импортируйте её в приложение из раздела «Приложения» на сайте.');
  } catch (e) {
    await send(chatId, 'Не удалось выпустить конфигурацию: ' + (e instanceof Error ? e.message : 'ошибка'));
  }
}
