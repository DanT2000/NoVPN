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
    // decryptSecret бросает на нечитаемом шифртексте (сменился/потерялся
    // ENCRYPTION_KEY). Это НЕ должно ронять процесс через unhandledRejection —
    // отдаём прокси без пароля, вызывающий обработает отказ связи штатно.
    let pass = '';
    if (encPass) {
      try {
        pass = decryptSecret(encPass);
      } catch {
        pass = '';
      }
    }
    const authp = tg.proxyLogin ? `${enc(tg.proxyLogin)}:${enc(pass)}@` : '';
    return `${tg.proxyType}://${authp}${tg.proxyHost}:${tg.proxyPort}`;
  }
  return null;
}

// Пул соединений с прокси переиспользуем: раньше на КАЖДЫЙ вызов создавался
// новый ProxyAgent и не закрывался (~агент/25с при polling + по агенту на каждого
// получателя рассылки) — утечка сокетов вплоть до EMFILE. Держим один агент на URL.
let cachedProxyUrl: string | null = null;
let cachedAgent: ProxyAgent | null = null;
function dispatcherFor(proxyUrl: string | null): ProxyAgent | undefined {
  if (!proxyUrl) return undefined;
  if (proxyUrl !== cachedProxyUrl) {
    try {
      void cachedAgent?.close();
    } catch {
      /* игнор */
    }
    cachedAgent = new ProxyAgent(proxyUrl);
    cachedProxyUrl = proxyUrl;
  }
  return cachedAgent ?? undefined;
}

/** Код ошибки Telegram (429 и т.п.) и retry_after — для корректного backoff. */
export class TgApiError extends Error {
  constructor(message: string, readonly code?: number, readonly retryAfter?: number) {
    super(message);
  }
}

/** Вызов Telegram Bot API через прокси. `signal` — внешняя отмена (стоп бота). */
export async function tgApi<T = any>(
  method: string,
  params: Record<string, unknown> = {},
  tokenOverride?: string,
  signal?: AbortSignal,
): Promise<T> {
  const token = tokenOverride ?? getToken();
  if (!token) throw new Error('Токен бота не задан.');
  const proxyUrl = resolveTgProxyUrl();
  const waitS = typeof params.timeout === 'number' ? params.timeout : 0;
  const timeout = AbortSignal.timeout((waitS + 15) * 1000);
  const opts: RequestInit & { dispatcher?: ProxyAgent } = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
    signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
  };
  const disp = dispatcherFor(proxyUrl);
  if (disp) opts.dispatcher = disp;
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, opts);
  const d = (await r.json()) as {
    ok: boolean;
    result?: T;
    description?: string;
    error_code?: number;
    parameters?: { retry_after?: number };
  };
  if (!d.ok) throw new TgApiError(d.description ?? 'Telegram error', d.error_code, d.parameters?.retry_after);
  return d.result as T;
}

// Защита от перебора кодов через бота: не более N попыток на чат за окно.
const linkAttempts = new Map<number, { count: number; resetAt: number }>();
function linkGuard(chatId: number): boolean {
  const now = Date.now();
  const WINDOW = 10 * 60 * 1000;
  const MAX = 5;
  // Периодически подчищаем истёкшие записи, чтобы map не рос бесконечно.
  if (linkAttempts.size > 500) for (const [k, v] of linkAttempts) if (now > v.resetAt) linkAttempts.delete(k);
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
const RESTART_DELAY_MS = 1200;
let running = false;
let offset = 0;
let loopId = 0;
let lastTokenSig = '';
let activeAbort: AbortController | null = null;

/** Дешёвая подпись токена (не сам секрет) — чтобы заметить смену бота. */
function tokenSig(token: string): string {
  return `${token.slice(0, 6)}:${token.length}`;
}

function saveBotUsername(username: string | undefined): void {
  if (!username) return;
  try {
    const cur = repo.getTelegram();
    if ((cur as { botUsername?: string }).botUsername === username) return;
    repo.saveTelegramRaw({ ...cur, botUsername: username });
  } catch {
    /* запись username не критична — не роняем бота */
  }
}

export function stopBot(): void {
  running = false;
  loopId += 1; // инвалидируем текущий цикл
  // Немедленно рвём висящий long-poll (getUpdates до 25с), иначе старый и новый
  // циклы спорят за getUpdates и Telegram отвечает 409.
  try {
    activeAbort?.abort();
  } catch {
    /* игнор */
  }
}

export async function startBot(): Promise<void> {
  // Чтение настроек/токена может бросить (SQLITE_BUSY при бэкапе, битая БД).
  // Не даём этому превратиться в unhandledRejection и уронить панель.
  let token = '';
  try {
    const tg = repo.getTelegram();
    token = getToken();
    if (!tg?.enabled || !token) return;
  } catch {
    return;
  }
  // Токен сменился → у нового бота своя нумерация update_id. Если оставить старый
  // (большой) offset, getUpdates молча подтверждает все апдейты нового бота и он
  // «мёртв» до перезапуска процесса. Сбрасываем offset при смене токена.
  const sig = tokenSig(token);
  if (sig !== lastTokenSig) {
    offset = 0;
    lastTokenSig = sig;
  }
  running = true;
  void pollLoop(++loopId);
}

export function restartBot(): void {
  stopBot();
  setTimeout(() => {
    startBot().catch((e) => console.error('[NoVPN] restartBot:', e instanceof Error ? e.message : e));
  }, RESTART_DELAY_MS);
}

async function pollLoop(myLoop: number): Promise<void> {
  let webhookCleared = false;
  while (running && myLoop === loopId) {
    const abort = new AbortController();
    activeAbort = abort;
    try {
      // Снимаем возможный webhook (иначе getUpdates даёт 409). Повторяем, пока не
      // выйдет: раньше это делалось один раз до цикла, и при недоступном прокси
      // webhook так и оставался → вечный 409, бот молчал навсегда.
      if (!webhookCleared) {
        await tgApi('deleteWebhook', { drop_pending_updates: false }, undefined, abort.signal);
        webhookCleared = true;
      }
      // Узнаём username, пока не знаем (для кнопки «Привязать Telegram» в кабинете).
      try {
        const cur = repo.getTelegram() as { botUsername?: string };
        if (!cur?.botUsername) {
          const me = await tgApi<{ username?: string }>('getMe', {}, undefined, abort.signal);
          saveBotUsername(me.username);
        }
      } catch {
        /* username узнаем на следующей итерации */
      }
      const updates = await tgApi<Array<Record<string, any>>>(
        'getUpdates',
        { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] },
        undefined,
        abort.signal,
      );
      // Нас могли выключить/сменить, пока висел long-poll — не обрабатываем чужие апдейты.
      if (!running || myLoop !== loopId) break;
      for (const u of updates) {
        offset = (u.update_id as number) + 1;
        try {
          await handleUpdate(u);
        } catch {
          /* один сбойный апдейт не должен ронять цикл */
        }
        if (!running || myLoop !== loopId) break;
      }
    } catch (e) {
      if (!running || myLoop !== loopId) break; // отменили — тихо выходим
      // 409 Conflict — висит другой getUpdates или остался webhook: сбросим флаг,
      // на следующей итерации снова снимем webhook.
      const code = e instanceof TgApiError ? e.code : undefined;
      if (code === 409 || (e instanceof Error && /conflict/i.test(e.message))) webhookCleared = false;
      const retryMs = e instanceof TgApiError && e.retryAfter ? e.retryAfter * 1000 : 8000;
      await sleep(retryMs);
    }
  }
}

// Одновременно допускаем только одну рассылку: повторное нажатие «Отправить» не
// должно запускать вторую параллельно (кратное превышение лимитов Telegram).
let broadcasting = false;
const MSG_TIMEOUT_MS = 6000; // на одно сообщение (не 15с — чтобы мёртвый токен не вешал рассылку надолго)
const CONSEC_FAIL_ABORT = 5; // подряд столько провалов ⇒ токен/прокси мертвы, прекращаем

/** Экстренная рассылка всем активным привязанным пользователям (по одному сообщению).
 *  Последовательно, с паузой (лимит Telegram ~30 сообщений/сек). Заблокировавшие бота
 *  молча пропускаются. При мёртвом токене/прокси прекращает рано, а не висит часами. */
export async function broadcastToLinked(text: string): Promise<{ total: number; sent: number; failed: number; aborted: boolean }> {
  const body = text.trim();
  if (!body) throw new Error('Пустое сообщение.');
  if (!getToken()) throw new Error('Бот не настроен: задайте токен в настройках Telegram.');
  let enabled = false;
  try {
    enabled = !!repo.getTelegram()?.enabled;
  } catch {
    enabled = false;
  }
  if (!enabled) throw new Error('Бот выключен. Включите бота в настройках Telegram и повторите.');
  if (broadcasting) throw new Error('Рассылка уже выполняется. Дождитесь её завершения.');
  broadcasting = true;
  let sent = 0;
  let failed = 0;
  let consecFail = 0;
  let aborted = false;
  let targets: Array<{ id: string; name: string; chatId: number }> = [];
  try {
    // Внутри try: если чтение целей бросит (SQLITE_BUSY при бэкапе), finally снимет
    // флаг — иначе мьютекс залип бы навсегда и все рассылки блокировались.
    targets = repo.listTelegramTargets();
    for (const t of targets) {
      try {
        await tgApi('sendMessage', { chat_id: t.chatId, text: body, disable_web_page_preview: true }, undefined, AbortSignal.timeout(MSG_TIMEOUT_MS));
        sent += 1;
        consecFail = 0;
      } catch (e) {
        // 429 — превышение частоты: подождём retry_after и повторим один раз.
        if (e instanceof TgApiError && e.code === 429 && e.retryAfter) {
          await sleep(Math.min(e.retryAfter * 1000, 30000));
          try {
            await tgApi('sendMessage', { chat_id: t.chatId, text: body, disable_web_page_preview: true }, undefined, AbortSignal.timeout(MSG_TIMEOUT_MS));
            sent += 1;
            consecFail = 0;
            await sleep(60);
            continue;
          } catch {
            /* повтор не удался — считаем провалом ниже */
          }
        }
        // Заблокировал/удалил бота (403), устаревший chat_id (400) — штатный случай:
        // Telegram ОТВЕТИЛ, значит токен и прокси живы. Такие адресаты просто
        // пропускаются и НЕ считаются в consecFail — иначе 5 подряд заблокировавших
        // бота (порядок целей произвольный) прервали бы всю экстренную рассылку (#9).
        // В consecFail попадают только признаки мёртвой инфраструктуры (таймаут/сеть/5xx).
        failed += 1;
        const definiteReply = e instanceof TgApiError && typeof e.code === 'number' && e.code >= 400 && e.code < 500;
        if (definiteReply) {
          consecFail = 0;
        } else {
          consecFail += 1;
          if (consecFail >= CONSEC_FAIL_ABORT) {
            aborted = true;
            break;
          }
        }
      }
      await sleep(60); // ~16 сообщений/сек — с запасом под лимит Telegram
    }
  } finally {
    broadcasting = false;
  }
  repo.addLog(
    `Экстренная рассылка: отправлено ${sent} из ${targets.length}${failed ? `, не доставлено ${failed}` : ''}${aborted ? ' (прервана: бот/прокси недоступны)' : ''}`,
  );
  return { total: targets.length, sent, failed, aborted };
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

/** Разбор команды бота. Учитывает суффикс @botname (Telegram добавляет его в
 *  группах и подсказках) и отделяет полезную нагрузку. `/configfoo` командой НЕ
 *  считается. */
export function parseCommand(text: string): { name: 'start' | 'menu' | 'config'; payload: string } | null {
  const m = /^\/(start|menu|config)(?:@\S+)?(?:\s+([\s\S]*))?$/i.exec(text);
  if (!m) return null;
  return { name: m[1]!.toLowerCase() as 'start' | 'menu' | 'config', payload: (m[2] ?? '').trim() };
}

function siteUrl(): string {
  const d = repo.getSettings()?.domain || '';
  return d ? (/^https?:\/\//i.test(d) ? d : `https://${d}`) : '';
}

const PROTO_LABEL: Record<string, string> = { xray: 'Xray (VLESS)', amneziawg: 'AmneziaWG' };

// Идентификация по неизменяемому chat_id (безопасно от подмены @username);
// handle — только фолбэк для legacy-привязок без chat_id.
function findUser(chatId: number, handle: string) {
  return repo.findBotUser(chatId, handle);
}

function mainMenu(user: { name: string; deviceLimit: number | null; id: string }): { text: string; kb: Kb } {
  // Лимит устройств относится к AmneziaWG (у каждого свои ключи). Xray — одна общая
  // подписка на любое число устройств, лимитом устройств не считается.
  const awg = repo.countActiveDevices(user.id, 'amneziawg');
  const hasXray = repo.countActiveDevices(user.id, 'xray') > 0;
  const text =
    `Меню — ${user.name}\n` +
    (hasXray ? 'Xray-подписка: активна (на все устройства)\n' : '') +
    `Устройств AmneziaWG: ${awg}${user.deviceLimit != null ? ` из ${user.deviceLimit}` : ' (без лимита)'}\n\n` +
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
  // Только личные чаты. Привязка в группе навесила бы аккаунт на весь чат: любой
  // участник получал бы конфиги и список устройств чужого пользователя.
  if (msg.chat?.type && msg.chat.type !== 'private') return;
  const chatId = msg.chat.id as number;
  const text = (msg.text as string).trim();
  const handle = handleOf(msg.from ?? {}, chatId);

  // Команды меню/конфига для уже привязанных. Строгий разбор: «/config» — это
  // команда (с опциональным @botname), а «/configfoo» — нет. «/start <payload>» —
  // это привязка, обрабатываем её ниже.
  const cmd = parseCommand(text);
  if (cmd && cmd.name !== 'start') {
    const linked = findUser(chatId, handle);
    if (linked) {
      if (cmd.name === 'config') return startGetConfig(chatId, linked);
      return showMenu(chatId, linked);
    }
  }

  // Привязка. Основной способ — переход из кабинета по кнопке: там deep-link
  // /start <токен>. Токен длинный и не подбирается. Короткий код тоже принимаем,
  // пока он ещё жив у мигрированных пользователей.
  let payload = '';
  if (cmd?.name === 'start') {
    payload = cmd.payload;
    if (!payload) {
      const linked = findUser(chatId, handle);
      if (linked) return showMenu(chatId, linked);
      await send(chatId, 'Привет! Чтобы привязать Telegram, откройте личный кабинет на сайте и нажмите «Привязать Telegram».');
      return;
    }
  } else if (cmd) {
    // /menu, /config и т.п. без привязки — подсказываем, как привязаться.
    await send(chatId, 'Сначала привяжите Telegram: откройте личный кабинет на сайте и нажмите «Привязать Telegram».');
    return;
  } else {
    payload = text;
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
    const linked = findUser(chatId, handle);
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
  // Всегда «гасим» кнопку, чтобы у пользователя не крутился спиннер.
  try {
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
  } catch {
    /* игнор */
  }
  const chat = cb.message?.chat;
  const chatId = chat?.id as number | undefined;
  // Устаревший callback без message (Telegram отдал только inline_message_id) или
  // нажатие в группе — ничего сделать не можем/не должны.
  if (typeof chatId !== 'number' || (chat?.type && chat.type !== 'private')) return;
  const data = String(cb.data ?? '');
  const handle = handleOf(cb.from ?? {}, chatId);
  const user = findUser(chatId, handle);
  if (!user) {
    await send(chatId, 'Сначала привяжите Telegram: откройте личный кабинет на сайте и нажмите «Привязать Telegram».');
    return;
  }
  repo.setTelegramChatId(user.id, chatId); // бэкофилл chat_id для рассылки
  if (data === 'menu') return showMenu(chatId, user);
  if (data === 'getcfg') return startGetConfig(chatId, user);
  // Выпуск не блокирует poll-loop: SSH может тянуться 30–60с, и await заморозил бы бота
  // для ВСЕХ. issueAndSend сам шлёт «Выпускаю…» и результат/ошибку — запускаем в фоне.
  if (data.startsWith('proto:')) {
    void issueAndSend(chatId, user, data.slice(6) as 'xray' | 'amneziawg').catch(() => {});
    return;
  }
  if (data === 'devices') return sendDevices(chatId, user);
  if (data === 'howto') return sendHowto(chatId, user);
  if (data === 'apps') return sendApps(chatId);
}

async function startGetConfig(chatId: number, user: ReturnType<typeof findUser> & object): Promise<void> {
  if (!user.isActive) return void send(chatId, 'Доступ отключён администратором.');
  if (user.expiresAt && new Date(user.expiresAt) < new Date()) return void send(chatId, 'Срок действия доступа истёк.');
  // Лимит устройств НЕ проверяем здесь: переиспользование существующего Xray-конфига
  // (подписка одна на все устройства) лимитом не считается, а раньше эта пред-проверка
  // ложно блокировала выдачу «своего же» конфига пользователю на лимите. Единый
  // источник правды — issueForUser; для AWG он корректно откажет с понятным текстом.
  // Сервер, на котором реально выпустим (тот же, что и в issueAndSend).
  const serverId = user.defaultServerId || user.allowedServers[0];
  const server = serverId ? repo.getServer(serverId) : null;
  if (!server) return void send(chatId, 'Для вашего доступа не назначен сервер. Обратитесь к администратору.');
  // Предлагаем ТОЛЬКО протоколы, установленные на этом сервере (как в веб-визарде) —
  // иначе выбор гарантированно упирался бы в «сервер не поддерживает протокол».
  const protos = (user.allowedProtocols.filter((p) => p === 'xray' || p === 'amneziawg') as Array<'xray' | 'amneziawg'>).filter((p) =>
    server.protocols.includes(p),
  );
  if (protos.length === 0) return void send(chatId, 'На вашем сервере нет доступных вам протоколов. Обратитесь к администратору.');
  if (protos.length === 1) {
    void issueAndSend(chatId, user, protos[0]!).catch(() => {}); // в фоне, не блокируя poll-loop
    return;
  }
  const kb: Kb = protos.map((p) => [{ text: PROTO_LABEL[p]!, callback_data: `proto:${p}` }]);
  await send(chatId, 'Какой протокол выпустить?', { kb });
}

/** Отправить блок с содержимым (ссылка/.conf) отдельным сообщением, безопасно.
 *  Раньше parse_mode=Markdown молча ронял сообщение, если в тексте были символы
 *  разметки (_ * ` [), — пользователь видел «Готово», но конфиг не приходил.
 *  Шлём как обычный текст без parse_mode — надёжно копируется целиком. */
async function sendBlock(chatId: number, caption: string, payload: string): Promise<boolean> {
  await send(chatId, caption);
  return sendRaw(chatId, payload);
}

/** Прямая отправка текста без parse_mode; возвращает успех (для диагностики). */
async function sendRaw(chatId: number | string, text: string): Promise<boolean> {
  try {
    await tgApi('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true });
    return true;
  } catch {
    return false;
  }
}

async function issueAndSend(chatId: number, user: ReturnType<typeof findUser> & object, protocol: 'xray' | 'amneziawg'): Promise<void> {
  if (!user.allowedProtocols.includes(protocol)) return void send(chatId, 'Этот протокол вам недоступен.');
  const serverId = user.defaultServerId || user.allowedServers[0];
  if (!serverId) return void send(chatId, 'Для вашего доступа не назначен сервер. Обратитесь к администратору.');
  await send(chatId, `Выпускаю конфиг (${PROTO_LABEL[protocol]})…`);
  try {
    const out = await issueForUser(user, 'Telegram', serverId, protocol);
    if (protocol === 'xray') {
      // Подписочная модель, как в кабинете: одна ссылка-подписка на ВСЕ устройства
      // (приложение само тянет и обновляет конфиги со всех разрешённых серверов).
      // Продвинутый режим (глоб. настройка, по умолчанию вкл) → /full: обход белых
      // списков + аварийный фоллбэк. Та же логика, что в веб-кабинете.
      const base = out.subscriptionUrl ?? repo.subscriptionUrl(user.id) ?? out.link ?? '';
      const advanced = repo.getSettings().xrayWhitelist !== false;
      // /full добавляем ТОЛЬКО к настоящей ссылке-подписке (…/sub/<токен>), а не к
      // запасному vless://-конфигу, иначе получился бы битый vless://…/full.
      const subUrl = advanced && base.includes('/sub/') && !base.endsWith('/full') ? `${base}/full` : base;
      const ok = await sendBlock(chatId, 'Готово! Ваша ссылка-подписка (одна на все устройства) — скопируйте целиком:', subUrl);
      if (!ok) {
        await send(chatId, 'Не удалось отправить ссылку. Откройте личный кабинет на сайте и скопируйте её там.');
        return;
      }
      await send(chatId, '📖 Откройте приложение (Happ / V2RayTun) → «+» → «Добавить подписку / Импорт из буфера» → вставьте ссылку → подключитесь.', {
        kb: [[{ text: '⬇️ Приложения', callback_data: 'apps' }], [{ text: '‹ Меню', callback_data: 'menu' }]],
      });
      return;
    }
    // AmneziaWG: .conf + ссылка vpn:// (для AmneziaVPN) — как в кабинете.
    const conf = out.conf ?? '';
    const ok = await sendBlock(chatId, 'Готово! Ваш конфиг AmneziaWG — сохраните текст ниже как файл .conf:', conf);
    if (!ok) {
      await send(chatId, 'Не удалось отправить конфиг. Откройте личный кабинет на сайте и скачайте его там.');
      return;
    }
    if (out.vpnKey) {
      await sendBlock(chatId, 'Ссылка vpn:// — для приложения AmneziaVPN (импорт в один тап):', out.vpnKey);
    }
    await send(chatId, '📖 AmneziaWG: импортируйте файл .conf. AmneziaVPN: откройте ссылку vpn:// выше.', {
      kb: [[{ text: '⬇️ Приложения', callback_data: 'apps' }], [{ text: '‹ Меню', callback_data: 'menu' }]],
    });
  } catch (e) {
    await send(chatId, 'Не удалось выпустить конфиг: ' + (e instanceof Error ? e.message : 'ошибка') + '\nПопробуйте ещё раз чуть позже.', {
      kb: [[{ text: 'Повторить', callback_data: `proto:${protocol}` }], [{ text: '‹ Меню', callback_data: 'menu' }]],
    });
  }
}

async function sendDevices(chatId: number, user: ReturnType<typeof findUser> & object): Promise<void> {
  const devices = repo.listDevicesOfUser(user.id).filter((d) => d.isActive);
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
