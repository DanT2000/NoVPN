// Telegram-бот: работает через прокси (прод в РФ не достаёт api.telegram.org напрямую).
// Умеет: привязка по токену личной ссылки (/start <token>, deep-link из кабинета)
// или по 6-значному коду, пока он жив; и выдача конфига (/config).

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

// Защита от перебора кодов через бота: не более N попыток на чат за окно.
const linkAttempts = new Map<number, { count: number; resetAt: number }>();
function linkGuard(chatId: number): boolean {
  const now = Date.now();
  const WINDOW = 10 * 60 * 1000;
  const MAX = 5;
  const rec = linkAttempts.get(chatId);
  if (!rec || now > rec.resetAt) {
    linkAttempts.set(chatId, { count: 1, resetAt: now + WINDOW });
    return true;
  }
  if (rec.count >= MAX) return false;
  rec.count += 1;
  return true;
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
      const updates = await tgApi<Array<Record<string, any>>>('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] });
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

/** Экстренная рассылка всем привязанным пользователям (по одному сообщению).
 *  Отправляет последовательно с паузой (лимит Telegram ~30 сообщений/сек),
 *  заблокировавшие бота молча пропускаются. Возвращает счётчики. */
export async function broadcastToLinked(text: string): Promise<{ total: number; sent: number; failed: number }> {
  const body = text.trim();
  if (!body) throw new Error('Пустое сообщение.');
  if (!getToken()) throw new Error('Бот не настроен: задайте токен в настройках Telegram.');
  const targets = repo.listTelegramTargets();
  let sent = 0;
  let failed = 0;
  for (const t of targets) {
    try {
      await tgApi('sendMessage', { chat_id: t.chatId, text: body, disable_web_page_preview: true });
      sent += 1;
    } catch {
      // Пользователь заблокировал/удалил бота или chat_id устарел — пропускаем.
      failed += 1;
    }
    await sleep(60); // ~16 сообщений/сек — с запасом под лимит Telegram
  }
  repo.addLog(`Экстренная рассылка: отправлено ${sent} из ${targets.length}`);
  return { total: targets.length, sent, failed };
}

type Kb = Array<Array<{ text: string; callback_data: string }>>;

async function send(chatId: number | string, text: string, opts: { markdown?: boolean; kb?: Kb } = {}): Promise<void> {
  try {
    await tgApi('sendMessage', {
      chat_id: chatId,
      text,
      ...(opts.markdown ? { parse_mode: 'Markdown' } : {}),
      ...(opts.kb ? { reply_markup: { inline_keyboard: opts.kb } } : {}),
      disable_web_page_preview: true,
    });
  } catch {
    /* игнор */
  }
}

/** Идентификатор пользователя Telegram для привязки. */
function handleOf(from: Record<string, any>, chatId: number): string {
  return from?.username ? `@${from.username}` : `id:${chatId}`;
}

function siteUrl(): string {
  const d = repo.getSettings()?.domain || '';
  return d ? (/^https?:\/\//i.test(d) ? d : `https://${d}`) : '';
}

const PROTO_LABEL: Record<string, string> = { xray: 'Xray (VLESS)', amneziawg: 'AmneziaWG' };

function findUser(handle: string) {
  return repo.listUsers().find((u) => u.telegram === handle);
}

function mainMenu(user: { name: string; deviceLimit: number | null; id: string }): { text: string; kb: Kb } {
  const active = repo.countActiveDevices(user.id);
  const text =
    `Меню — ${user.name}\n` +
    `Устройств: ${active}${user.deviceLimit != null ? ` из ${user.deviceLimit}` : ' (без лимита)'}\n\n` +
    `Выберите действие:`;
  const kb: Kb = [
    [{ text: '➕ Получить конфиг', callback_data: 'getcfg' }],
    [
      { text: '📱 Мои устройства', callback_data: 'devices' },
      { text: '📖 Как подключить', callback_data: 'howto' },
    ],
    [{ text: '⬇️ Приложения', callback_data: 'apps' }],
  ];
  return { text, kb };
}

async function showMenu(chatId: number, user: { name: string; deviceLimit: number | null; id: string }): Promise<void> {
  const m = mainMenu(user);
  await send(chatId, m.text, { kb: m.kb });
}

async function handleUpdate(u: Record<string, any>): Promise<void> {
  if (u.callback_query) return handleCallback(u.callback_query);
  const msg = u.message ?? u.edited_message;
  if (!msg || typeof msg.text !== 'string') return;
  const chatId = msg.chat.id as number;
  const text = (msg.text as string).trim();
  const handle = handleOf(msg.from ?? {}, chatId);
  // Бэкофилл chat_id для уже привязанных (поле telegram хранит только handle).
  { const l = findUser(handle); if (l) repo.setTelegramChatId(l.id, chatId); }

  // Команды меню/конфига для уже привязанных. «/start <payload>» с полезной
  // нагрузкой — это привязка, её пропускаем ниже, поэтому исключаем.
  const isStartWithPayload = /^\/start\s+\S/.test(text);
  if ((/^\/(menu|config|start$)/i.test(text) || /меню|получить конфиг/i.test(text)) && !isStartWithPayload) {
    const linked = findUser(handle);
    if (linked) {
      if (/config|получить конфиг/i.test(text)) return startGetConfig(chatId, linked);
      return showMenu(chatId, linked);
    }
  }

  // Привязка. Основной способ — переход из кабинета по кнопке: там deep-link
  // /start <токен>. Токен длинный и не подбирается. Короткий код тоже принимаем,
  // пока он ещё жив у мигрированных пользователей.
  let payload = '';
  if (text.startsWith('/start')) {
    payload = text.replace('/start', '').trim();
    if (!payload) {
      const linked = findUser(handle);
      if (linked) return showMenu(chatId, linked);
      await send(chatId, 'Привет! Чтобы привязать Telegram, откройте личный кабинет на сайте и нажмите «Привязать Telegram».');
      return;
    }
  } else {
    payload = text.trim();
  }

  // Привязка по 6-значному коду — только для тех, у кого вход по коду СЕЙЧАС
  // разрешён (не истёк), и с защитой от перебора (иначе бот — открытый брутфорс
  // 10^6 кодов с угоном чужого аккаунта). Личная ссылка (длинный токен) не
  // подбирается — для неё ограничений нет.
  let user = null as ReturnType<typeof repo.getUserByAccessToken>;
  if (/^\d{6}$/.test(payload)) {
    if (!linkGuard(chatId)) {
      await send(chatId, 'Слишком много попыток. Попробуйте позже или откройте личную ссылку с сайта.');
      return;
    }
    const cand = repo.getUserByCode(payload);
    const until = cand ? repo.getCodeLoginUntil(cand.id) : null;
    if (cand && until && new Date(until) > new Date()) user = cand;
  } else {
    user = repo.getUserByAccessToken(payload);
  }
  if (!user) {
    const linked = findUser(handle);
    if (linked) return showMenu(chatId, linked);
    await send(chatId, 'Не удалось привязать. Откройте личный кабинет на сайте и нажмите «Привязать Telegram».');
    return;
  }
  repo.updateUserFields(user.id, { telegram: handle });
  repo.setTelegramChatId(user.id, chatId);
  repo.addHistory(user.id, `Привязан Telegram: ${handle}`);
  await send(chatId, `Готово, ${user.name}! Telegram привязан. ✅`);
  await showMenu(chatId, user);
}

async function handleCallback(cb: Record<string, any>): Promise<void> {
  const chatId = cb.message?.chat?.id as number;
  const data = String(cb.data ?? '');
  const handle = handleOf(cb.from ?? {}, chatId);
  try {
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
  } catch {
    /* игнор */
  }
  const user = findUser(handle);
  if (!user) {
    await send(chatId, 'Сначала привяжите Telegram: откройте личный кабинет на сайте и нажмите «Привязать Telegram».');
    return;
  }
  repo.setTelegramChatId(user.id, chatId); // бэкофилл chat_id для рассылки
  if (data === 'menu') return showMenu(chatId, user);
  if (data === 'getcfg') return startGetConfig(chatId, user);
  if (data.startsWith('proto:')) return issueAndSend(chatId, user, data.slice(6) as 'xray' | 'amneziawg');
  if (data === 'devices') return sendDevices(chatId, user);
  if (data === 'howto') return sendHowto(chatId, user);
  if (data === 'apps') return sendApps(chatId);
}

async function startGetConfig(chatId: number, user: ReturnType<typeof findUser> & object): Promise<void> {
  if (!user.isActive) return void send(chatId, 'Доступ отключён администратором.');
  if (user.expiresAt && new Date(user.expiresAt) < new Date()) return void send(chatId, 'Срок действия доступа истёк.');
  if (user.deviceLimit != null && repo.countActiveDevices(user.id) >= user.deviceLimit)
    return void send(chatId, `Достигнут лимит устройств (${user.deviceLimit}). Отключите старое устройство или обратитесь к администратору.`);
  const protos = user.allowedProtocols.filter((p) => p === 'xray' || p === 'amneziawg') as Array<'xray' | 'amneziawg'>;
  if (protos.length === 0) return void send(chatId, 'Для вашего доступа не выбран протокол. Обратитесь к администратору.');
  if (protos.length === 1) return issueAndSend(chatId, user, protos[0]!);
  const kb: Kb = protos.map((p) => [{ text: PROTO_LABEL[p]!, callback_data: `proto:${p}` }]);
  await send(chatId, 'Какой протокол выпустить?', { kb });
}

async function issueAndSend(chatId: number, user: ReturnType<typeof findUser> & object, protocol: 'xray' | 'amneziawg'): Promise<void> {
  if (!user.allowedProtocols.includes(protocol)) return void send(chatId, 'Этот протокол вам недоступен.');
  const serverId = user.defaultServerId || user.allowedServers[0];
  if (!serverId) return void send(chatId, 'Для вашего доступа не назначен сервер. Обратитесь к администратору.');
  await send(chatId, `Выпускаю конфиг (${PROTO_LABEL[protocol]})…`);
  try {
    const out = await issueForUser(user, 'Telegram', serverId, protocol);
    const cfg = out.link ?? out.conf ?? '';
    await send(chatId, `Готово! Ваш конфиг (${PROTO_LABEL[protocol]}) — скопируйте целиком:`);
    await send(chatId, '```\n' + cfg + '\n```', { markdown: true });
    const tip =
      protocol === 'xray'
        ? 'Откройте приложение (Happ / V2RayTun) → «+» → «Импорт из буфера» → вставьте ссылку → подключитесь.'
        : 'Откройте AmneziaWG / AmneziaVPN → импортируйте .conf (текст выше сохраните как файл .conf) → активируйте.';
    await send(chatId, `📖 ${tip}`, { kb: [[{ text: '⬇️ Приложения', callback_data: 'apps' }], [{ text: '‹ Меню', callback_data: 'menu' }]] });
  } catch (e) {
    await send(chatId, 'Не удалось выпустить конфиг: ' + (e instanceof Error ? e.message : 'ошибка') + '\nПопробуйте ещё раз чуть позже.', {
      kb: [[{ text: 'Повторить', callback_data: `proto:${protocol}` }], [{ text: '‹ Меню', callback_data: 'menu' }]],
    });
  }
}

async function sendDevices(chatId: number, user: ReturnType<typeof findUser> & object): Promise<void> {
  const devices = repo.listDevices().filter((d) => d.userId === user.id && d.isActive);
  if (devices.length === 0) {
    await send(chatId, 'У вас пока нет активных конфигов.', { kb: [[{ text: '➕ Получить конфиг', callback_data: 'getcfg' }], [{ text: '‹ Меню', callback_data: 'menu' }]] });
    return;
  }
  const lines = devices.map((d, i) => {
    const srv = repo.getServer(d.serverId);
    return `${i + 1}. ${d.name} — ${PROTO_LABEL[d.protocol] ?? d.protocol}${srv ? ` · ${srv.name}` : ''}`;
  });
  await send(chatId, `📱 Ваши устройства (${devices.length}):\n\n` + lines.join('\n'), {
    kb: [[{ text: '➕ Получить конфиг', callback_data: 'getcfg' }], [{ text: '‹ Меню', callback_data: 'menu' }]],
  });
}

async function sendHowto(chatId: number, user: ReturnType<typeof findUser> & object): Promise<void> {
  const site = siteUrl();
  const protos = user.allowedProtocols;
  const parts = ['📖 Как подключить:', ''];
  if (protos.includes('xray')) parts.push('• Xray: приложение Happ или V2RayTun → «+» → «Импорт из буфера» → вставьте выданную ссылку.');
  if (protos.includes('amneziawg')) parts.push('• AmneziaWG: приложение AmneziaWG/AmneziaVPN → импорт .conf или скан QR.');
  parts.push('', 'Нажмите «Получить конфиг», затем импортируйте его в приложение.');
  if (site) parts.push('', `Все приложения и инструкции: ${site}`);
  await send(chatId, parts.join('\n'), {
    kb: [
      [{ text: '➕ Получить конфиг', callback_data: 'getcfg' }, { text: '⬇️ Приложения', callback_data: 'apps' }],
      [{ text: '‹ Меню', callback_data: 'menu' }],
    ],
  });
}

async function sendApps(chatId: number): Promise<void> {
  const site = siteUrl();
  const apps = repo.listApps().filter((a) => a.enabled).slice(0, 8);
  const lines = ['⬇️ Приложения:', ''];
  for (const a of apps) {
    const link = a.source || a.platforms.find((p) => p.url)?.url || '';
    lines.push(`• ${a.client}${link ? ` — ${link}` : ''}`);
  }
  if (site) lines.push('', `Полный список с инструкциями по платформам: ${site}`);
  await send(chatId, lines.join('\n'), { kb: [[{ text: '‹ Меню', callback_data: 'menu' }]] });
}
