// Все HTTP-роуты. Пути совпадают с httpApi фронтенда.

import net from 'node:net';
import express, { Router } from 'express';
import type { Request } from 'express';
import type {
  AppSettings,
  IssueDeviceResult,
  PublicUserView,
  TelegramSettings,
  User,
} from '@novpn/shared';
import { buildWhitelistXrayConfig } from '@novpn/shared';
import type { ProxyFallback } from '@novpn/shared';
import { config } from './config.js';
import { requireAdmin, requireUserOrAdmin } from './middleware/auth.js';
import { sshHasSshAccess, sshCreateXray, sshCreateAwg, sshRevokeXray, sshRevokeAwg, sshRevokeProxyUser, sshInstallProxies, sshInstallServer, sshUninstallServer, sshResyncDevices, sshProbe, sshReadAwgParams, genAwgParams, sshSetXraySni, sshPickPort, sshSetPortAlias, sshIsPortFree, sshHardenToKey, REALITY_SNI } from './services/sshServer.js';
import type { AwgParams } from './services/sshServer.js';
import { saveServerKeys, saveServerProxy, getServerProxy, getServerKeys, deleteServerKeys } from './services/keyvault.js';
import { decryptSecret, encryptSecret, encConf, maskTail, randomToken } from './lib/crypto.js';
import { createXrayCfg, createAwgCfg, issueForUser, issueProxyForUser, revokeUserAccessOnServers, revokeDeviceOnServer } from './services/issue.js';
import { createBackup, decryptBackup, restoreBackup } from './services/backup.js';
import { vpnLinkFromConf } from './services/amneziaLink.js';
import { renderSubPage } from './services/subPage.js';
import * as appFiles from './services/appFiles.js';
import { resolveTgProxyUrl, restartBot, tgApi, broadcastToLinked } from './services/telegram.js';
import * as guard from './services/loginGuard.js';
import { isDefaultAdminPassword, setAdminPassword, verifyAdminPassword } from './services/adminAuth.js';
import * as repo from './repo.js';
import { checkMirror } from './services/routingSync.js';
import { renderGuidePage } from './services/guides.js';
import { renderDownloadPage } from './services/downloadPage.js';
import {
  getDesktopConfig,
  setDesktopConfig,
  currentManifest,
  listVersions,
  acceptUpload,
  mirrorCheck,
  type DesktopChannelConfig,
} from './services/desktopChannel.js';

export const router = Router();

const err = (type: string, message: string) => ({ error: { type, message } });

const toPublicUserView = repo.toPublicUserView;

/** Устройство принадлежит вошедшему пользователю? Админу разрешено всё —
 *  он управляет устройствами из панели. */
function ownsDevice(req: Request, d: { userId: string | null }): boolean {
  if (req.session?.admin) return true;
  return !!d.userId && d.userId === req.session?.userId;
}

/** Адрес клиента. За edge-прокси реальный адрес приходит в X-Forwarded-For,
 *  express разбирает его сам (trust proxy включён в app.ts). */
function clientIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

/** Адрес, по которому пользователь реально обратился к панели (учитывая обратный
 *  прокси). Нужен, чтобы генерируемые ссылки работали даже без заданного домена. */
function reqOrigin(req: { headers: Record<string, unknown>; protocol?: string }): string {
  const h = req.headers;
  const proto = String(h['x-forwarded-proto'] || req.protocol || 'https').split(',')[0]!.trim();
  const host = String(h['x-forwarded-host'] || h.host || '').split(',')[0]!.trim();
  return host ? `${proto}://${host}` : '';
}

// ── health ──
router.get('/healthz', (_req, res) => res.json({ status: 'ok' }));

// ── публично: файлы умной маршрутизации (для NoVPN Desktop) ──
// Клиентам всегда даётся стабильный URL этой панели, даже когда содержимое —
// зеркало внешнего источника. Секретов нет, отдаём без авторизации.
const ROUTING_NAMES = new Set(['upstream', 'sites', 'apps']);
router.get('/routing/:file', (req, res) => {
  const name = String(req.params.file ?? '').replace(/\.json$/i, '');
  if (!ROUTING_NAMES.has(name)) return res.status(404).json(err('not_found', 'Файл не найден.'));
  const content = repo.getRoutingContent(name);
  if (content == null) return res.status(404).json(err('not_found', 'Файл не найден.'));
  const row = repo.getRoutingRow(name);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (row) res.setHeader('ETag', `W/"v${row.version}"`);
  res.setHeader('Cache-Control', 'public, max-age=60');
  return res.send(content);
});

// ── публично: страница «Скачать» (NoVPN Desktop + расширение) ──
router.get('/download', (_req, res) => {
  const s = repo.getSettings();
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.send(
    renderDownloadPage({
      appName: repo.brandName(),
      version: currentManifest()?.version ?? null,
      extChromeUrl: s.extChromeUrl,
      extEdgeUrl: s.extEdgeUrl,
      extYandexUrl: s.extYandexUrl,
      extFirefoxUrl: s.extFirefoxUrl,
    }),
  );
});

// ── публично: инструкция приложения (Markdown-гайд с картинками) ──
router.get('/guide/:appId', (req, res) => {
  const html = renderGuidePage(String(req.params.appId ?? ''));
  if (!html) return res.status(404).send('Инструкция не найдена.');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.send(html);
});

// ── подписка Xray ──
// Клиенты (Happ, v2rayTun, Streisand, NekoBox) умеют «подписку»: раз добавил
// ссылку — дальше сам тянет список конфигов и обновляет их. Отдаём base64 от
// списка vless://-ссылок, как принято в экосистеме.
//
// Токен подписки ОТДЕЛЬНЫЙ от токена входа: подписка живёт в приложении и может
// утечь вместе с ним, но пускать в личный кабинет она не должна.
router.get('/sub/:token', (req, res) => {
  const u = repo.getUserBySubToken(String(req.params.token ?? ''));
  if (!u || !u.isActive) return res.status(404).send('');
  if (u.expiresAt && new Date(u.expiresAt) < new Date()) return res.status(404).send('');

  // Квота исчерпана — не отдаём конфиги (клиент увидит это по Subscription-Userinfo
  // ниже и перестанет подключаться). Раньше подписка продолжала слать конфиги
  // даже при превышении лимита трафика.
  const overQuota = u.trafficLimitGb != null && (u.trafficUsedGb ?? 0) >= u.trafficLimitGb;
  // Одна подписка = ОДИН Xray-конфиг на сервер (дедуп на чтении — см. repo).
  const links = overQuota ? [] : repo.subscriptionXrayLinks(u.id);

  // Один адрес — два ответа. Браузер просит text/html: показываем страницу с
  // приложениями и инструкцией. VPN-приложение просит что угодно другое:
  // отдаём base64-список конфигов. Так человеку достаточно ОДНОЙ ссылки:
  // открыл — понял что делать, вставил в приложение — получил конфиги.
  if (String(req.headers.accept ?? '').includes('text/html')) {
    const base = repo.publicBaseUrl(reqOrigin(req));
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, private'); // страница содержит личную ссылку-подписку
    return res.send(
      renderSubPage({
        appName: repo.brandName(),
        user: u,
        subUrl: `${base}/sub/${req.params.token}`,
        apps: repo.listApps(),
        configCount: links.length,
        whitelist: repo.getSettings().xrayWhitelist !== false,
      }),
    );
  }

  // Заголовки, которые читают клиенты подписок.
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, private'); // тело = конфиги пользователя, не кэшировать
  res.setHeader('Profile-Title', `base64:${Buffer.from(repo.brandName(), 'utf8').toString('base64')}`);
  res.setHeader('Profile-Update-Interval', '12');
  if (u.trafficLimitGb != null) {
    const total = Math.round(u.trafficLimitGb * 1e9);
    const used = Math.round((u.trafficUsedGb ?? 0) * 1e9);
    const expire = u.expiresAt ? Math.floor(new Date(u.expiresAt).getTime() / 1000) : 0;
    res.setHeader('Subscription-Userinfo', `upload=0; download=${used}; total=${total}; expire=${expire}`);
  }
  res.send(Buffer.from(links.join('\n'), 'utf8').toString('base64'));
});

// Полный Xray-конфиг с обходом «белых списков»: RU-домены напрямую, остальное —
// через reality-прокси. Для V2RayNG/Xray-core (импорт как «свой конфиг»). Тот же
// токен подписки. Отдаём JSON-файлом.
// Сборка полного Xray-конфига для набора ссылок + политики КОНКРЕТНОГО сервера
// (srv=null → глобальная политика для агрегированной подписки). Возвращает JSON или
// null (пусто/все ссылки битые → НЕ отдаём all-direct утечку). Один источник правды
// для агрегированной /full и пер-серверной /server/:id/full.
function buildUserXrayFull(
  u: NonNullable<ReturnType<typeof repo.getUser>>,
  links: string[],
  srv: ReturnType<typeof repo.getServer>,
  overQuota: boolean,
): string | null {
  if (links.length === 0) return null;
  // Свой значок сервера И флаг страны показываем ВМЕСТЕ (🏠🇫🇮), а не либо-либо.
  const emoji = srv ? (srv.flagEmoji || '').trim() : '';
  const cflag = srv ? ((srv.country || '').trim().match(/^(\p{Regional_Indicator}{2})/u)?.[1] ?? '') : '';
  const title = srv ? [[emoji, cflag].filter(Boolean).join(''), srv.name].filter(Boolean).join(' ') : '';
  // Настройки генерации ПЕР-СЕРВЕР (обход-домены, LAN, набор фоллбэк-прокси, полный
  // туннель), с фолбэком на глобальные, если сервер не задан (агрегированная подписка).
  const cfg = srv
    ? repo.getEndpointConfig(srv.host)
    : { xrayWhitelist: repo.getSettings().xrayWhitelist !== false, whitelistDomains: repo.getSettings().whitelistDomains, lanAccess: repo.getSettings().lanAccess === true, fallbackTypes: null as null };
  // Аварийный фоллбэк — ПЕР-СЕРВЕР: берём ТОЛЬКО прокси ЭТОГО сервера (srv.id), а не все
  // прокси пользователя. Иначе на конфиг одного сервера (напр. домашний полный туннель,
  // где своих прокси нет) навешивались бы прокси ДРУГОГО сервера + observatory/балансиры,
  // и на холодном старте/сбое пробы весь трафик уходил в block («сайты не грузятся»).
  // Нет своих прокси → простой xray-конфиг без «умных» надстроек — ровно как просил владелец.
  const typeOrder: Record<string, number> = { https: 0, http: 1, socks5: 2 };
  const allowFb = (t: 'https' | 'http' | 'socks5') => !cfg.fallbackTypes || cfg.fallbackTypes.includes(t === 'socks5' ? 'socks' : t);
  const proxies: ProxyFallback[] = [];
  if (!overQuota) {
    for (const row of repo.listProxyAccountRowsOfUser(u.id)) {
      if (srv && row.server_id !== srv.id) continue; // аварийка только со СВОЕГО сервера
      const view = repo.buildProxyAccountView(row);
      if (!view) continue;
      for (const e of [...view.endpoints].sort((a, b) => (typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9))) {
        if (!allowFb(e.type as 'https' | 'http' | 'socks5')) continue;
        proxies.push({ kind: e.type === 'socks5' ? 'socks' : (e.type as 'https' | 'http'), host: e.host, port: e.port, user: view.login, pass: view.password });
      }
    }
  }
  // Пер-серверный «продвинутый режим» выкл → полный туннель (всё через VPN, без исключений).
  const disableWhitelist = cfg.xrayWhitelist === false;
  return buildWhitelistXrayConfig(links, repo.brandName(), proxies, title, cfg.whitelistDomains, cfg.lanAccess, disableWhitelist) || null;
}

// Заголовки+тело полного конфига (одинаковы для агрегированной и пер-серверной подписки).
function sendUserXrayFull(res: import('express').Response, u: NonNullable<ReturnType<typeof repo.getUser>>, json: string): void {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, private'); // полный конфиг с ключами, не кэшировать
  res.setHeader('Profile-Title', `base64:${Buffer.from(repo.brandName(), 'utf8').toString('base64')}`);
  res.setHeader('Profile-Update-Interval', '12');
  if (u.trafficLimitGb != null) {
    const total = Math.round(u.trafficLimitGb * 1e9);
    const used = Math.round((u.trafficUsedGb ?? 0) * 1e9);
    const expire = u.expiresAt ? Math.floor(new Date(u.expiresAt).getTime() / 1000) : 0;
    res.setHeader('Subscription-Userinfo', `upload=0; download=${used}; total=${total}; expire=${expire}`);
  }
  res.send(json);
}

// ЕДИНАЯ подписка: у КАЖДОГО сервера свой полный конфиг со СВОЕЙ маршрутизацией
// (обход у Finland, полный туннель у домашнего — без смешивания). Несколько серверов →
// JSON-МАССИВ конфигов (формат экосистемы: Happ/v2rayNG/Streisand создают по профилю
// на элемент из одной подписки, человек переключается в приложении). Один сервер →
// один JSON-объект (прежнее поведение, совместимость с уже добавленными ссылками).
router.get('/sub/:token/full', (req, res) => {
  const u = repo.getUserBySubToken(String(req.params.token ?? ''));
  if (!u || !u.isActive) return res.status(404).send('');
  if (u.expiresAt && new Date(u.expiresAt) < new Date()) return res.status(404).send('');
  const overQuota = u.trafficLimitGb != null && (u.trafficUsedGb ?? 0) >= u.trafficLimitGb;
  // Старейший конфиг первым: у уже подключённых людей первый профиль в приложении
  // остаётся их исходным сервером (entries идут новые-первыми — разворачиваем).
  const entries = (overQuota ? [] : repo.subscriptionXrayEntries(u.id)).reverse();
  const parts: string[] = [];
  for (const e of entries) {
    const srv = repo.getServer(e.serverId);
    const json = buildUserXrayFull(u, [e.link], srv, overQuota);
    if (json) parts.push(json);
  }
  if (parts.length === 0) return res.status(404).send(''); // пусто/битое → не отдаём all-direct утечку
  sendUserXrayFull(res, u, parts.length === 1 ? parts[0]! : `[\n${parts.join(',\n')}\n]`);
});

// Пер-серверная подписка: ОДИН сервер со СВОИМ обходом/политикой (не общий балансир).
// В приложении = отдельный профиль на сервер. Ссылки формируются в bootstrap.servers[].subLink.
router.get('/sub/:token/server/:id/full', (req, res) => {
  const u = repo.getUserBySubToken(String(req.params.token ?? ''));
  if (!u || !u.isActive) return res.status(404).send('');
  if (u.expiresAt && new Date(u.expiresAt) < new Date()) return res.status(404).send('');
  const serverId = String(req.params.id ?? '');
  // Доступ строго как у subscriptionXrayLinks: сервер разрешён, xray-протокол, не отвязан.
  if (!u.allowedProtocols.includes('xray') || !u.allowedServers.includes(serverId)) return res.status(404).send('');
  const srv = repo.getServer(serverId);
  if (!srv || srv.detached || !srv.protocols.includes('xray')) return res.status(404).send('');
  const overQuota = u.trafficLimitGb != null && (u.trafficUsedGb ?? 0) >= u.trafficLimitGb;
  const links = overQuota ? [] : repo.subscriptionXrayLinks(u.id, serverId);
  const json = buildUserXrayFull(u, links, srv, overQuota);
  if (!json) return res.status(404).send('');
  sendUserXrayFull(res, u, json);
});

// ── bootstrap ──
// ТОЛЬКО для админа: содержит коды доступа всех пользователей и конфиги всех
// устройств. Публичная часть сайта пользуется /api/public/bootstrap.
router.get('/api/bootstrap', requireAdmin, (_req, res) => {
  // Пока пароль дефолтный — НЕ раскрываем данные (коды/токены/устройства/прокси):
  // отдаём пустышку с флагом смены, чтобы UI показал экран смены пароля. Полные данные —
  // только после установки своего пароля.
  if (isDefaultAdminPassword())
    return res.json({
      users: [], devices: [], servers: [], apps: [], settings: repo.getSettings(),
      telegram: { enabled: false, tokenMasked: null, mode: 'polling', proxyOn: false, proxyType: 'http', proxyHost: '', proxyPort: '', proxyLogin: '', proxyPassSet: false, template: '', status: 'stopped', linkedUserIds: [] },
      adminLog: [], jobErrors: [], history: {},
      dbHealth: { dbPath: '', container: true, confirmedPersistent: true, risky: false },
      mustChangePassword: true,
    });
  res.json(repo.buildBootstrap());
});

// Данные публичной части. Без входа по коду — только справочники;
// со входом — плюс свои устройства. Чужое не отдаётся никогда.
router.get('/api/public/bootstrap', (req, res) => {
  res.json(repo.buildPublicBootstrap(req.session?.userId, reqOrigin(req)));
});

/** Общие проверки доступа, одинаковые для входа по коду и по ссылке. */
function accessError(u: User): { type: string; message: string } | null {
  if (!u.isActive) return { type: 'disabled', message: 'Доступ отключён. Обратитесь к администратору.' };
  if (u.expiresAt && new Date(u.expiresAt) < new Date()) return { type: 'expired', message: 'Срок действия доступа истёк.' };
  if (u.trafficLimitGb != null && u.trafficUsedGb >= u.trafficLimitGb)
    return { type: 'traffic', message: 'Лимит трафика исчерпан. Обратитесь к администратору.' };
  return null;
}

// ── public: check code ──
// Старый способ входа. Работает только у тех, кому он был разрешён при переходе
// на ссылки, и только до code_login_until. Защищён от перебора: 6 цифр — это
// миллион вариантов, без лимита попыток рабочий код находится за час.
router.post('/api/public/check-code', (req, res) => {
  // Отдельный от админского входа bucket: перебор кода не должен блокировать
  // вход администратора с того же IP, и наоборот.
  const ip = `code:${clientIp(req)}`;
  const gate = guard.checkAllowed(ip);
  if (!gate.allowed) return res.status(429).json(err('rate_limited', gate.message!));

  const code = String(req.body?.code ?? '');
  const u = repo.getUserByCode(code);
  if (!u) {
    const v = guard.noteFailure(ip);
    return res.json(err(v.allowed ? 'not_found' : 'rate_limited', v.allowed ? 'Код не найден. Проверьте правильность ввода.' : v.message!));
  }
  // Вход по коду разрешён не всем и не навсегда.
  const until = repo.getCodeLoginUntil(u.id);
  if (!until || new Date(until) < new Date()) {
    guard.noteFailure(ip);
    return res.json(err('disabled', 'Вход по коду больше не работает. Откройте личную ссылку, которую вам отправил администратор.'));
  }
  const bad = accessError(u);
  // Отказ доступа по ВАЛИДНОМУ коду тоже расходует бюджет перебора: иначе такой
  // ответ был бы «бесплатным» зондом, отличающим существующий код от несуществующего.
  if (bad) {
    guard.noteFailure(ip);
    return res.json(err(bad.type, bad.message));
  }
  // Вход по коду числом устройств НЕ ограничиваем: лимит относится к выпуску
  // AmneziaWG-устройств и проверяется при выдаче, а не при входе.

  guard.noteSuccess(ip);
  // Регенерируем сессию при входе (анти-фиксация: заранее подложенный SID не станет
  // авторизованным). Личность берётся из свежей сессии, не из тела запроса.
  req.session.regenerate((e) => {
    if (e) return res.status(500).json(err('server', 'Ошибка сессии, повторите вход.'));
    req.session.userId = u.id;
    res.json({ user: toPublicUserView(u), codeLoginUntil: until });
  });
});

// ── public: вход по личной ссылке ──
// Основной способ: токен длинный, перебирать бессмысленно, набирать руками не надо.
router.post('/api/public/token-login', (req, res) => {
  const token = String(req.body?.token ?? '');
  const u = token ? repo.getUserByAccessToken(token) : null;
  if (!u) return res.json(err('not_found', 'Ссылка недействительна. Попросите у администратора новую.'));
  const bad = accessError(u);
  if (bad) return res.json(err(bad.type, bad.message));
  req.session.regenerate((e) => {
    if (e) return res.status(500).json(err('server', 'Ошибка сессии, повторите вход.'));
    req.session.userId = u.id;
    res.json({ user: toPublicUserView(u) });
  });
});

router.post('/api/public/logout', (req, res) => {
  delete req.session.userId;
  res.json({ ok: true });
});


// ── public: issue device ──
router.post('/api/public/devices', requireUserOrAdmin, async (req, res) => {
  try {
    const { name, serverId, protocol } = req.body ?? {};
    // Личность — из сессии; userId из тела принимается только от админа,
    // который выпускает конфиг за пользователя из панели. Иначе любой мог бы
    // выпустить конфиг за другого, просто подставив чужой id.
    const targetId = req.session.admin && req.body?.userId ? String(req.body.userId) : String(req.session.userId);
    const u = repo.getUser(targetId);
    if (!u) return res.status(404).json(err('not_found', 'Пользователь не найден.'));
    // Статус/срок/квоту проверяет issueForUser, где админ (byAdmin) не ограничен —
    // чтобы предвыпустить конфиг приостановленному. Здесь блокируем только неадмина.
    if (!u.isActive && !req.session.admin) return res.status(403).json(err('disabled', 'Доступ отключён.'));
    if (protocol !== 'xray' && protocol !== 'amneziawg') return res.status(400).json(err('validation', 'Неизвестный протокол.'));
    // Лимит устройств (только AmneziaWG) и все проверки — внутри issueForUser,
    // единый источник правды. Дублирующая пред-проверка убрана, чтобы не расходиться.
    const out = await issueForUser(u, String(name || 'Устройство'), String(serverId), protocol, { byAdmin: !!req.session.admin });
    res.json(out);
  } catch (e) {
    res.status(400).json(err('server', e instanceof Error ? e.message : 'Ошибка выпуска конфига.'));
  }
});

router.post('/api/public/devices/:id/reissue', requireUserOrAdmin, async (req, res) => {
  try {
    const d = repo.getDevice(req.params.id!);
    if (!d || !d.userId) return res.status(404).json(err('not_found', 'Устройство не найдено.'));
    if (!ownsDevice(req, d)) return res.status(404).json(err('not_found', 'Устройство не найдено.'));
    const u = repo.getUser(d.userId);
    if (!u) return res.status(404).json(err('not_found', 'Пользователь не найден.'));
    if (d.protocol !== 'xray' && d.protocol !== 'amneziawg') return res.status(400).json(err('validation', 'Протокол не поддерживается.'));
    // Перевыпуск — это ВЫПУСК свежего рабочего конфига, поэтому подчиняется тому же
    // гейту доступа, что и обычная выдача: приостановленный/истёкший/исчерпавший квоту
    // НЕ-админ иначе восстановил бы VPN из живой сессии, обойдя отключение и лимит
    // трафика (в т.ч. enforcement квоты AWG/Xray). Админ (byAdmin) — без ограничений.
    if (!req.session.admin) {
      const bad = accessError(u);
      if (bad) return res.status(403).json(err(bad.type, bad.message));
    }
    const server = repo.getServer(d.serverId)!;
    // Лимит устройств (только AmneziaWG): перевыпуск НЕАКТИВНОГО AWG-устройства = его
    // повторная активация, поэтому подчиняется тому же лимиту, что и новый выпуск.
    // Иначе можно было бы обойти лимит, реактивируя отключённые устройства. Админ — без лимита.
    if (
      !req.session.admin && !d.isActive && d.protocol === 'amneziawg' &&
      u.deviceLimit != null && repo.countActiveDevices(u.id, 'amneziawg') >= u.deviceLimit
    ) {
      return res.status(403).json(err('devices', `Достигнут лимит устройств AmneziaWG (${u.deviceLimit}). Отключите другое устройство.`));
    }

    // СНАЧАЛА отзываем старый доступ на сервере. Иначе перевыпуск лишь забывает
    // старый ключ в панели, а на сервере он продолжает работать — навсегда и уже
    // без возможности отозвать (панель его перезатёрла). Именно ради этого
    // перевыпуск обычно и жмут: ключ утёк.
    const oldRow = repo.getDeviceRow(d.id);
    if (oldRow && (await sshHasSshAccess(server.id))) {
      if (oldRow.protocol === 'xray' && oldRow.uuid) await sshRevokeXray(server, oldRow.uuid);
      else if (oldRow.protocol === 'amneziawg' && oldRow.public_key) await sshRevokeAwg(server, oldRow.public_key);
    }

    let out: IssueDeviceResult;
    // quota_blocked: 0 — перевыпуск даёт СВЕЖИЙ живой пир на сервере, поэтому запись
    // возвращается в нормальное состояние enforcement. Если пользователь всё ещё сверх
    // лимита (админский перевыпуск), следующий цикл sync сам снимет пир заново; иначе
    // остался бы is_active=1 И quota_blocked=1 с рабочим пиром, который sync не трогает.
    if (d.protocol === 'xray') {
      const r = await createXrayCfg(server, d.name);
      const device = repo.updateDeviceFields(d.id, { is_active: 1, revoked_at: null, revoke_pending: 0, quota_blocked: 0, uuid: r.uuid, public_key: r.publicKey, link: r.link, conf: null })!;
      out = { device, link: r.link };
    } else {
      const r = await createAwgCfg(server, d.name);
      const device = repo.updateDeviceFields(d.id, {
        is_active: 1, revoked_at: null, revoke_pending: 0, quota_blocked: 0, public_key: r.publicKey, private_key_enc: encryptSecret(r.privateKey),
        preshared_key_enc: encryptSecret(r.presharedKey), client_ip: r.clientIp, conf: encConf(r.conf), link: null,
      })!;
      const vk = vpnLinkFromConf(r.conf, `${repo.brandName()} — ${server.name}`);
      out = { device, conf: r.conf, vpnKeyAvailable: !!vk, vpnKey: vk ?? undefined };
    }
    repo.addHistory(u.id, `Перевыпущен конфиг «${d.name}»`);
    res.json(out);
  } catch (e) {
    res.status(400).json(err('server', e instanceof Error ? e.message : 'Ошибка.'));
  }
});

router.post('/api/public/devices/:id/revoke', requireUserOrAdmin, async (req, res) => {
  const d = repo.getDevice(req.params.id!);
  if (!d) return res.status(404).json(err('not_found', 'Устройство не найдено.'));
  if (!ownsDevice(req, d)) return res.status(404).json(err('not_found', 'Устройство не найдено.'));
  // Реальный отзыв на сервере. Подтверждён → ставим revoked_at (запись очистится
  // автоматически через grace). Сервер недоступен → revoke_pending: доступ снят в
  // панели, но запись НЕ удаляем и sync повторит отзыв (иначе конфиг осиротел бы живым).
  const revoked = await revokeDeviceOnServer(d.id);
  repo.updateDeviceFields(
    d.id,
    revoked ? { is_active: 0, revoked_at: repo.nowIso(), revoke_pending: 0 } : { is_active: 0, revoked_at: null, revoke_pending: 1 },
  );
  res.json({ ok: true, pending: !revoked });
});

router.delete('/api/public/devices/:id', requireUserOrAdmin, async (req, res) => {
  const d = repo.getDevice(req.params.id!);
  if (!d || !ownsDevice(req, d)) return res.status(404).json(err('not_found', 'Устройство не найдено.'));
  // Удалять запись безопасно ТОЛЬКО когда серверный отзыв подтверждён. Если конфиг
  // ещё активен или отзыв «висит» (revoke_pending), сначала отзываем; не удалось —
  // сохраняем запись как pending (sync повторит), иначе живой ключ осиротеет навсегда.
  const row = repo.getDeviceRow(d.id);
  if (d.isActive || row?.revoke_pending) {
    const revoked = await revokeDeviceOnServer(d.id);
    if (!revoked) {
      repo.updateDeviceFields(d.id, { is_active: 0, revoked_at: null, revoke_pending: 1 });
      return res.json({ ok: false, pending: true, message: 'Сервер недоступен — запись сохранена, отзыв повторится автоматически.' });
    }
  }
  repo.deleteDevice(req.params.id!);
  res.json({ ok: true });
});

// Переименовать конфиг (пользователь в кабинете или админ из карточки).
router.post('/api/public/devices/:id/rename', requireUserOrAdmin, (req, res) => {
  const d = repo.getDevice(req.params.id!);
  if (!d || !ownsDevice(req, d)) return res.status(404).json(err('not_found', 'Устройство не найдено.'));
  const name = String(req.body?.name ?? '').trim();
  if (!name) return res.status(400).json(err('validation', 'Укажите название.'));
  const updated = repo.renameDevice(d.id, name);
  res.json(updated);
});

// Массовая очистка конфигов: отзываем на сервере и удаляем записи. Идентичный путь
// для кабинета (пользователь чистит свои) и админки (админ чистит любые — ownsDevice
// пускает admin). Клиент присылает только те id, что оставил отмеченными.
router.post('/api/public/devices/cleanup', requireUserOrAdmin, async (req, res) => {
  const rawIds = Array.isArray(req.body?.ids) ? (req.body.ids as unknown[]).map(String) : [];
  // Ограничение: отзыв идёт по SSH последовательно, длинный список — риск таймаута.
  const ids = rawIds.slice(0, 100);
  if (ids.length === 0) return res.json({ deleted: 0, kept: 0, keptIds: [] });
  let deleted = 0;
  let kept = 0;
  const keptIds: string[] = []; // id, что оставили (сервер был недоступен) — для точной синхронизации кэша
  for (const id of ids) {
    const d = repo.getDevice(id);
    if (!d || !ownsDevice(req, d)) continue; // чужое/несуществующее — молча пропускаем
    // Отзываем на сервере, если конфиг ещё активен ИЛИ отзыв не подтверждён (revoke_pending):
    // иначе удаление осиротит живой ключ (неактивное устройство могло не отозваться на
    // недоступном сервере). Только с подтверждённым отзывом запись безопасно удалять.
    const row = repo.getDeviceRow(d.id);
    if (d.isActive || row?.revoke_pending) {
      const revoked = await revokeDeviceOnServer(d.id);
      if (!revoked) {
        // Сервер недоступен — не удаляем физически. revoke_pending: доступ снят в панели,
        // sync повторит отзыв; revoked_at НЕ ставим, чтобы автоочистка не удалила до подтверждения.
        repo.updateDeviceFields(d.id, { is_active: 0, revoked_at: null, revoke_pending: 1 });
        kept += 1;
        keptIds.push(d.id);
        continue;
      }
    }
    repo.deleteDevice(d.id);
    if (d.userId) repo.addHistory(d.userId, `Удалён конфиг «${d.name}» (очистка)`);
    deleted += 1;
  }
  res.json({ deleted, kept, keptIds });
});

// Выдать/получить прокси-аккаунт пользователя на сервере.
router.post('/api/public/proxy', requireUserOrAdmin, async (req, res) => {
  try {
    const { serverId } = req.body ?? {};
    const targetId = req.session.admin && req.body?.userId ? String(req.body.userId) : String(req.session.userId);
    const u = repo.getUser(targetId);
    if (!u) return res.status(404).json(err('not_found', 'Пользователь не найден.'));
    // issueProxyForUser проверяет статус/срок/квоту; админ (byAdmin) не ограничен.
    if (!u.isActive && !req.session.admin) return res.status(403).json(err('disabled', 'Доступ отключён.'));
    const acc = await issueProxyForUser(u, String(serverId), { byAdmin: !!req.session.admin });
    res.json(acc);
  } catch (e) {
    res.status(400).json(err('server', e instanceof Error ? e.message : 'Не удалось выдать прокси.'));
  }
});

// Отозвать прокси-аккаунт (удаляет логин на сервере).
router.post('/api/public/proxy/:id/revoke', requireUserOrAdmin, async (req, res) => {
  const row = repo.getProxyAccountRow(req.params.id!);
  if (!row) return res.status(404).json(err('not_found', 'Прокси не найден.'));
  // Владелец или админ.
  if (!req.session.admin && row.user_id !== String(req.session.userId))
    return res.status(404).json(err('not_found', 'Прокси не найден.'));
  try {
    const server = repo.getServer(row.server_id);
    if (server && (await sshHasSshAccess(server.id))) await sshRevokeProxyUser(server, row.login);
    repo.deactivateProxyAccount(row.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json(err('server', e instanceof Error ? e.message : 'Не удалось отозвать прокси.'));
  }
});

// ── admin: auth ──
// Логина нет — панель одноадминная. Тот же лимит попыток, что и на коде: с
// паролем по умолчанию «admin» подбор иначе тривиален.
router.post('/api/admin/login', (req, res) => {
  const ip = `admin:${clientIp(req)}`;
  const gate = guard.checkAllowed(ip);
  if (!gate.allowed) return res.status(429).json(err('rate_limited', gate.message!));

  const { password } = req.body ?? {};
  const ok = verifyAdminPassword(String(password ?? ''));
  if (!ok) {
    const v = guard.noteFailure(ip);
    return res.json({ ok: false, message: v.allowed ? undefined : v.message });
  }
  guard.noteSuccess(ip);
  req.session.regenerate((e) => {
    if (e) return res.status(500).json({ ok: false, message: 'Ошибка сессии, повторите вход.' });
    req.session.admin = true;
    res.json({ ok: true, mustChangePassword: isDefaultAdminPassword() });
  });
});

// Смена пароля администратора из панели.
router.post('/api/admin/password', requireAdmin, (req, res) => {
  const current = String(req.body?.current ?? '');
  const next = String(req.body?.next ?? '');
  // При первой обязательной смене (пароль ещё дефолтный) текущий НЕ спрашиваем:
  // сессия уже подтверждает админа, а дефолт и так известен — это лишняя преграда.
  // В обычной смене (пароль уже задан) текущий проверяем.
  if (!isDefaultAdminPassword() && !verifyAdminPassword(current))
    return res.status(400).json(err('validation', 'Текущий пароль неверен.'));
  if (next.length < 6) return res.status(400).json(err('validation', 'Новый пароль — минимум 6 символов.'));
  setAdminPassword(next);
  repo.addLog('Изменён пароль администратора');
  res.json({ ok: true });
});

// Перезапуск панели (после смены домена/порта). Контейнер поднимется сам:
// в docker-compose стоит restart: unless-stopped.
router.post('/api/admin/restart', requireAdmin, (_req, res) => {
  repo.addLog('Перезапуск панели по кнопке из настроек');
  res.json({ ok: true });
  setTimeout(() => process.exit(0), 400);
});

// Экстренная рассылка: админ пишет текст — бот отправляет всем привязанным.
router.post('/api/admin/broadcast', requireAdmin, async (req, res) => {
  try {
    const text = String(req.body?.text ?? '').trim();
    if (!text) return res.status(400).json(err('validation', 'Введите текст сообщения.'));
    if (text.length > 4000) return res.status(400).json(err('validation', 'Слишком длинное сообщение (макс. 4000 символов).'));
    const r = await broadcastToLinked(text);
    if (r.aborted)
      return res.json({ ...r, message: `Рассылка прервана: бот или прокси недоступны. Доставлено ${r.sent} из ${r.total}.` });
    res.json(r);
  } catch (e) {
    res.status(400).json(err('server', e instanceof Error ? e.message : 'Не удалось разослать.'));
  }
});
router.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ── admin: users ──
router.post('/api/admin/users', requireAdmin, (req, res) => {
  const b = req.body ?? {};
  const name = String(b.name ?? '').trim();
  if (!name) return res.status(400).json(err('validation', 'Укажите имя пользователя.'));
  // Код — внутренний идентификатор (и метка для Telegram-бота). Основной способ
  // входа это личная ссылка, поэтому код можно не задавать: сгенерируем сами.
  // Вручную заданный код принимаем, если он валиден и свободен.
  let code = String(b.code ?? '').trim();
  if (code) {
    if (!/^\d{6}$/.test(code)) return res.status(400).json(err('validation', 'Код должен состоять из 6 цифр.'));
    if (repo.codeExists(code)) return res.status(400).json(err('validation', 'Такой код уже используется — выберите другой.'));
  } else {
    code = repo.genUniqueCode();
  }
  const allowedServers: string[] = Array.isArray(b.allowedServers) ? b.allowedServers : [];
  if (allowedServers.length === 0) return res.status(400).json(err('validation', 'Выберите хотя бы один сервер.'));
  const allowedProtocols = (Array.isArray(b.allowedProtocols) ? b.allowedProtocols : []).filter((p: string) => p === 'xray' || p === 'amneziawg');
  const allowedProxies = (Array.isArray(b.allowedProxies) ? b.allowedProxies : []).filter((p: string) => p === 'http' || p === 'https' || p === 'socks5');
  if (allowedProtocols.length === 0 && allowedProxies.length === 0)
    return res.status(400).json(err('validation', 'Выберите хотя бы один протокол или прокси.'));

  const u = repo.insertUser({
    name, comment: String(b.comment ?? ''), category: b.category ?? 'Общие', tags: Array.isArray(b.tags) ? b.tags : [],
    code, deviceLimit: b.deviceLimit ?? null, expiresAt: b.expiresAt ?? null, trafficLimitGb: b.trafficLimitGb ?? null,
    resetPolicy: b.resetPolicy === 'monthly' ? 'monthly' : 'never', allowedServers,
    allowedProtocols, allowedProxies,
    codeLoginEnabled: b.codeLoginEnabled === true,
  });
  repo.addLog(`Создан пользователь «${u.name}»`);
  repo.addHistory(u.id, 'Пользователь создан');
  res.json(u);
});

// Включить/выключить вход по коду для пользователя.
router.post('/api/admin/users/:id/code-login', requireAdmin, (req, res) => {
  const u = repo.getUser(req.params.id!);
  if (!u) return res.status(404).json(err('not_found', 'Пользователь не найден.'));
  const enabled = req.body?.enabled === true;
  repo.setCodeLogin(u.id, enabled);
  repo.addLog(`${enabled ? 'Включён' : 'Отключён'} вход по коду «${u.name}»`);
  res.json(repo.getUser(u.id));
});

router.patch('/api/admin/users/:id', requireAdmin, (req, res) => {
  const u = repo.getUser(req.params.id!);
  if (!u) return res.status(404).json(err('not_found', 'Пользователь не найден.'));
  const b = req.body ?? {};
  const fields: Record<string, unknown> = {};
  if (b.name !== undefined) fields.name = String(b.name);
  if (b.comment !== undefined) fields.comment = String(b.comment);
  if (b.category !== undefined) fields.category = b.category;
  if (b.tags !== undefined) fields.tags = JSON.stringify(b.tags);
  if (b.deviceLimit !== undefined) fields.device_limit = b.deviceLimit;
  if (b.trafficLimitGb !== undefined) fields.traffic_limit_gb = b.trafficLimitGb;
  if (b.expiresAt !== undefined) fields.expires_at = b.expiresAt; // null = снять срок
  if (b.resetPolicy !== undefined) fields.reset_policy = b.resetPolicy === 'monthly' ? 'monthly' : 'never';
  if (b.allowedServers !== undefined) fields.allowed_servers = JSON.stringify(b.allowedServers);
  if (b.allowedProtocols !== undefined)
    fields.allowed_protocols = JSON.stringify(
      (Array.isArray(b.allowedProtocols) ? (b.allowedProtocols as string[]) : []).filter((p) => p === 'xray' || p === 'amneziawg'),
    );
  if (b.allowedProxies !== undefined)
    fields.allowed_proxies = JSON.stringify(
      (Array.isArray(b.allowedProxies) ? (b.allowedProxies as string[]) : []).filter((p) => p === 'http' || p === 'https' || p === 'socks5'),
    );
  const updated = repo.updateUserFields(u.id, fields);
  // Сузили allowedServers/allowedProtocols → уже выданные конфиги вне нового списка
  // помечаем на отзыв (is_active=0, revoke_pending=1): sync-цикл снимет их с сервера
  // (retry-проход). Подписка их уже не отдаёт (см. subscriptionXrayLinks). Fix #1.
  if (updated && (b.allowedServers !== undefined || b.allowedProtocols !== undefined)) {
    const okServers = new Set(updated.allowedServers);
    const okProtos = new Set(updated.allowedProtocols);
    let revoked = 0;
    for (const d of repo.listDevicesOfUser(u.id)) {
      if (!d.isActive) continue;
      const outOfScope = (okServers.size > 0 && !okServers.has(d.serverId)) || !okProtos.has(d.protocol as (typeof updated.allowedProtocols)[number]);
      if (outOfScope) {
        repo.updateDeviceFields(d.id, { is_active: 0, revoke_pending: 1, revoked_at: null });
        revoked += 1;
      }
    }
    if (revoked) repo.addLog(`Профиль «${updated.name}»: снято ${revoked} конфиг(ов) вне разрешённых серверов/протоколов`);
  }
  res.json(updated);
});

// Перевыпуск личной ссылки: старая сразу перестаёт работать.
// Нужен, если ссылка утекла или человек просит новую.
router.post('/api/admin/users/:id/reissue-link', requireAdmin, (req, res) => {
  const u = repo.getUser(req.params.id!);
  if (!u) return res.status(404).json(err('not_found', 'Пользователь не найден.'));
  repo.resetAccessToken(u.id);
  repo.addLog(`Перевыпущена личная ссылка «${u.name}»`);
  repo.addHistory(u.id, 'Перевыпущена личная ссылка');
  res.json(repo.getUser(u.id));
});

router.post('/api/admin/users/:id/extend', requireAdmin, (req, res) => {
  const u = repo.getUser(req.params.id!);
  if (!u) return res.status(404).json(err('not_found', 'Пользователь не найден.'));
  // Ограничиваем days разумным диапазоном: без этого огромное/NaN значение давало
  // RangeError (Invalid time value) → 500. ±100 лет более чем достаточно.
  const raw = Number(req.body?.days ?? 0);
  const days = Number.isFinite(raw) ? Math.max(-36500, Math.min(36500, Math.trunc(raw))) : 0;
  const base = u.expiresAt && new Date(u.expiresAt) > new Date() ? new Date(u.expiresAt) : new Date();
  const expiresAt = new Date(base.getTime() + days * 86400000).toISOString();
  const updated = repo.updateUserFields(u.id, { expires_at: expiresAt });
  repo.addLog(`Продлён доступ «${u.name}» на ${days} дн`);
  res.json(updated);
});

router.post('/api/admin/users/:id/active', requireAdmin, async (req, res) => {
  const u = repo.getUser(req.params.id!);
  if (!u) return res.status(404).json(err('not_found', 'Пользователь не найден.'));
  const active = !!req.body?.active;
  repo.updateUserFields(u.id, { is_active: active ? 1 : 0 });
  if (!active) {
    // Сначала реально отзываем конфиги на VPN-серверах, затем помечаем в БД —
    // иначе отключённый пользователь продолжал бы пользоваться VPN.
    const { confirmed } = await revokeUserAccessOnServers(u.id);
    const ok = new Set(confirmed);
    // Приостановка — временная: revoked_at НЕ ставим (конфиги переживут паузу до
    // реактивации). Если серверный отзыв не подтвердился (сервер был недоступен) —
    // revoke_pending=2 (приостановка): sync повторит отзыв, но запись сохранит.
    for (const d of repo.listDevices().filter((x) => x.userId === u.id && x.isActive))
      repo.updateDeviceFields(d.id, { is_active: 0, revoke_pending: ok.has(d.id) ? 0 : 2 });
    repo.deactivateUserProxyAccounts(u.id);
  }
  res.json(repo.getUser(u.id));
});

router.post('/api/admin/users/:id/reissue-code', requireAdmin, (req, res) => {
  const u = repo.getUser(req.params.id!);
  if (!u) return res.status(404).json(err('not_found', 'Пользователь не найден.'));
  const code = repo.genUniqueCode();
  const updated = repo.updateUserFields(u.id, { code });
  repo.addLog(`Перевыпущен код для «${u.name}»`);
  res.json(updated);
});

router.post('/api/admin/users/:id/code', requireAdmin, (req, res) => {
  const u = repo.getUser(req.params.id!);
  if (!u) return res.status(404).json(err('not_found', 'Пользователь не найден.'));
  const code = String(req.body?.code ?? '').trim();
  if (!/^\d{6}$/.test(code)) return res.status(400).json(err('validation', 'Код — 6 цифр.'));
  if (repo.codeExists(code, u.id)) return res.status(400).json(err('validation', 'Такой код уже используется — выберите другой.'));
  res.json(repo.updateUserFields(u.id, { code })); // как reissue-code — возвращаем самого пользователя
});

router.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  const u = repo.getUser(req.params.id!);
  const confirmed = u ? (await revokeUserAccessOnServers(u.id)).confirmed : []; // сначала снять доступ на серверах
  repo.softDeleteUser(req.params.id!); // база: is_active=0, revoke_pending=1 (revoked_at пуст)
  // Только подтверждённым отзывам ставим revoked_at (таймер автоочистки). Остальные
  // остаются pending — sync повторит отзыв и подтвердит, прежде чем запись удалится.
  for (const id of confirmed) repo.markDeviceRevokeConfirmed(id, true);
  res.json({ ok: true });
});

// ── admin: servers ──
function tcpReachable(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const done = (v: boolean) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
    sock.connect(port, host);
  });
}

router.post('/api/admin/servers/test-ssh', requireAdmin, async (req, res) => {
  const b = req.body ?? {};
  const host = String(b.host || b.vpnHost || '').trim();
  const port = Number(b.sshPort) || 22;
  if (!host) return res.json({ ok: false, audit: [{ name: 'Хост', ok: false, note: 'адрес не указан' }] });
  // Реальная проверка: доступен ли SSH-порт хоста.
  const reachable = await tcpReachable(host, port, 5000);
  const audit = [
    {
      name: `SSH-порт ${port} на ${host}`,
      ok: reachable,
      note: reachable ? 'порт открыт, хост доступен' : 'не удалось подключиться — проверьте адрес/порт/файрвол',
    },
  ];
  if (!reachable) return res.json({ ok: false, audit });

  const secret = String(b.secret ?? '');
  if (!secret) {
    audit.push({ name: 'Вход по SSH', ok: false, note: 'укажите пароль или приватный ключ — без них панель не сможет управлять сервером' });
    return res.json({ ok: false, audit });
  }
  // Реальный аудит: заходим по SSH и смотрим, что на сервере.
  try {
    const p = await sshProbe({ host, port, user: String(b.sshUser || 'root'), secret });
    audit.push({ name: 'Вход по SSH', ok: true, note: `${p.OS || 'ОС определена'}${p.RAM ? `, RAM ${p.RAM} МБ` : ''}` });
    audit.push({ name: 'Docker', ok: p.DOCKER === 'yes', note: p.DOCKER === 'yes' ? 'установлен' : 'нет — будет установлен при провижининге' });

    const found: string[] = [];
    if (p.XRAY === 'yes') found.push('Xray');
    if (p.AWG === 'yes') found.push('AmneziaWG (на хосте)');
    if (p.VPNC) found.push(`контейнеры: ${p.VPNC}`);
    if (found.length) {
      const free = p.P443 !== 'busy' && p.P51820 !== 'busy';
      audit.push({
        name: '⚠️ На сервере уже есть VPN',
        ok: false,
        note:
          `Обнаружено: ${found.join('; ')}. ` +
          (free
            ? 'Наши порты (443/tcp, 51820/udp) свободны — установим свой VPN РЯДОМ, ваш существующий продолжит работать, мы его не трогаем и не удаляем. '
            : 'ВНИМАНИЕ: наши порты заняты — установка их перехватит, и существующий VPN на них перестанет работать. ') +
          'Панель обслуживает только те конфиги, которые выдаёт сама: старые конфиги вашего VPN она не видит и не сможет ими управлять.',
      });
    } else {
      audit.push({ name: 'Существующий VPN', ok: true, note: 'не обнаружен — установка будет чистой' });
    }
    const portsOk = p.P443 !== 'busy' && p.P51820 !== 'busy';
    audit.push({
      name: 'Порты 443/tcp и 51820/udp',
      ok: portsOk,
      note: portsOk ? 'свободны' : `заняты: ${[p.P443 === 'busy' ? '443' : '', p.P51820 === 'busy' ? '51820' : ''].filter(Boolean).join(', ')} — установка их займёт под себя`,
    });
    return res.json({ ok: true, audit });
  } catch (e) {
    audit.push({ name: 'Вход по SSH', ok: false, note: `не удалось войти: ${e instanceof Error ? e.message : 'ошибка'} — проверьте логин/пароль (или ключ)` });
    return res.json({ ok: false, audit });
  }
});

router.post('/api/admin/servers', requireAdmin, (req, res) => {
  const b = req.body ?? {};
  const components: string[] = Array.isArray(b.components) ? b.components : [];
  const protocols = components.filter((p) => ['xray', 'amneziawg', 'http', 'https', 'socks5'].includes(p));
  const publicHost = String(b.vpnHost || b.host || '');
  // Reattach: если по этому домену уже есть ОТВЯЗАННЫЙ сервер — переиспользуем его
  // строку (endpoint/ключи/конфиги живы), а не плодим дубль. Возвращаем восстановленный.
  const detachedSame = repo.listServers().find((x) => x.detached && x.host === publicHost);
  if (detachedSame) {
    repo.reattachServer(detachedSame.id, {
      host: b.host, port: b.sshPort, user: b.sshUser,
      passEnc: b.secret ? encryptSecret(String(b.secret)) : undefined,
    });
    if (protocols.length) repo.updateServerFields(detachedSame.id, { protocols: JSON.stringify(protocols) });
    repo.addLog(`Переподключён сервер к сохранённому endpoint «${detachedSame.name}» (${publicHost}) — старые конфиги восстановлены`);
    return res.json(repo.getServer(detachedSame.id));
  }
  // Одноразовый enrollment-token (для будущего агент-режима).
  const enrollToken = randomToken();
  // Если переданы серверные ключи — сервер уже установлен, панель работает по SSH.
  const hasKeys = !!(b.serverKeys && (b.serverKeys.awgServerPubKey || b.serverKeys.xrayRealityPubKey));
  const s = repo.insertServer({
    name: String(b.name ?? 'Сервер'), country: b.country ?? null, host: String(b.vpnHost || b.host || ''),
    protocols, agent: hasKeys ? 'online' : 'never', endpointOk: hasKeys,
    sshHost: b.host, sshPort: b.sshPort, sshUser: b.sshUser,
    // Секрет (пароль ИЛИ приватный ключ) — тип определяется по содержимому при подключении.
    sshPassEnc: b.secret ? encryptSecret(String(b.secret)) : null,
    enrollSecretEnc: encryptSecret(enrollToken),
  });
  if (b.flagEmoji) repo.updateServerFields(s.id, { flag_emoji: [...String(b.flagEmoji).replace(/\?/g, '')].slice(0, 8).join('') });
  if (hasKeys) {
    // Принимаем и ПРИВАТНЫЕ ключи + параметры обфускации — это регистрация уже
    // установленного сервера (или восстановление панели): с ними ранее выданные
    // конфиги продолжают работать, а переустановка на том же домене их вернёт.
    saveServerKeys(s.host, {
      xrayRealityPubKey: b.serverKeys.xrayRealityPubKey,
      xrayRealityPrivKey: b.serverKeys.xrayRealityPrivKey,
      xrayShortId: b.serverKeys.xrayShortId,
      xraySni: b.serverKeys.xraySni,
      awgServerPubKey: b.serverKeys.awgServerPubKey,
      awgServerPrivKey: b.serverKeys.awgServerPrivKey,
      awgParams: b.serverKeys.awgParams ? JSON.stringify(b.serverKeys.awgParams) : undefined,
    });
  }
  repo.addLog(`Добавлен сервер «${s.name}»`);
  res.json({ ...s, enrollToken });
});

router.patch('/api/admin/servers/:id', requireAdmin, (req, res) => {
  const s = repo.getServer(req.params.id!);
  if (!s) return res.status(404).json(err('not_found', 'Сервер не найден.'));
  const b = req.body ?? {};
  const fields: Record<string, unknown> = {};
  if (b.name !== undefined) fields.name = String(b.name);
  if (b.country !== undefined) fields.country = b.country || null;
  if (b.flagEmoji !== undefined) fields.flag_emoji = b.flagEmoji ? [...String(b.flagEmoji).replace(/\?/g, '')].slice(0, 8).join('') : null;
  const vpnHost = b.vpnHost ?? b.host;
  if (vpnHost !== undefined && String(vpnHost).trim()) fields.host = String(vpnHost).trim();
  if (b.sshHost !== undefined) fields.ssh_host = b.sshHost;
  if (b.sshPort !== undefined) fields.ssh_port = Number(b.sshPort) || 22;
  if (b.sshUser !== undefined) fields.ssh_user = b.sshUser;
  // Новый секрет (пароль или ключ) — только если пришёл непустой (иначе не трогаем).
  if (b.secret) fields.ssh_pass_enc = encryptSecret(String(b.secret));
  if (Array.isArray(b.components)) {
    const protocols = b.components.filter((p: string) => p === 'xray' || p === 'amneziawg' || p === 'http' || p === 'https' || p === 'socks5');
    fields.protocols = JSON.stringify(protocols);
  }
  const updated = repo.updateServerFields(s.id, fields) ?? s;
  // Обновление серверных ключей (для выпуска конфигов) — по домену.
  if (b.serverKeys && (b.serverKeys.awgServerPubKey || b.serverKeys.xrayRealityPubKey)) {
    saveServerKeys(updated.host, {
      xrayRealityPubKey: b.serverKeys.xrayRealityPubKey,
      xrayShortId: b.serverKeys.xrayShortId,
      xraySni: b.serverKeys.xraySni,
      awgServerPubKey: b.serverKeys.awgServerPubKey,
    });
    repo.updateServerFields(s.id, { agent: 'online', endpoint_ok: 1 });
  }
  repo.addLog(`Изменён сервер «${updated.name}»`);
  res.json(repo.getServer(s.id));
});

// Полный автоматический провижининг сервера (xray + awg + прокси) с нуля по SSH.
// Статус установки в памяти (установка длится минуты — делаем асинхронно, edge рвёт долгие запросы).
const provisionStatus = new Map<string, { state: 'running' | 'done' | 'error'; message: string; restored?: boolean; at: number }>();

async function runProvision(serverId: string, comps: string[], ports: { xray?: number; awg?: number } = {}): Promise<void> {
  const req_portXray = ports.xray;
  const req_portAwg = ports.awg;
  const s = repo.getServer(serverId);
  if (!s) return;
  const want = {
    xray: comps.includes('xray'), awg: comps.includes('amneziawg'),
    http: comps.includes('http'), https: comps.includes('https'), socks: comps.includes('socks5'),
  };
  try {
    const prev = getServerKeys(s.host);
    const restoring = !!(prev?.xrayRealityPrivKey || prev?.awgServerPrivKey);
    provisionStatus.set(serverId, { state: 'running', message: restoring ? 'Переустановка с восстановлением…' : 'Устанавливаем VPN…', at: Date.now() });

    // Параметры обфускации AmneziaWG — уникальны для сервера.
    // Приоритет: 1) сохранённые в keyvault → 2) уже стоящие на сервере (старые
    // установки: их НЕЛЬЗЯ менять, иначе выданные конфиги отвалятся) → 3) новые случайные.
    let awgParams: AwgParams | null = null;
    if (prev?.awgParams) {
      try {
        awgParams = JSON.parse(prev.awgParams) as AwgParams;
      } catch {
        awgParams = null;
      }
    }
    if (!awgParams) awgParams = await sshReadAwgParams(s);
    // Восстановление на НОВОМ боксе + пустой keyvault.awg_params (сервер до миграции
    // колонки): вытаскиваем параметры из уже выданного клиентского конфига, иначе
    // genAwgParams() сгенерил бы НОВЫЕ и все существующие AWG-конфиги отвалились бы.
    if (!awgParams && restoring) awgParams = repo.awgParamsFromDevice(s.id) as AwgParams | null;
    if (!awgParams) awgParams = genAwgParams();

    // Публичные порты endpoint'а. Восстановление по домену → берём сохранённые (старые
    // конфиги живут). Новый endpoint → auto-pick: Xray предпочитает 443 (если свободен),
    // AmneziaWG — случайный НЕ-дефолтный UDP (Amnezia рекомендует нестандартный).
    // Явные значения из формы (portXray/portAwg) имеют приоритет.
    // Восстановление (реальные ключи по домену) → сохранённые порты (старые конфиги
    // живут). Свежий endpoint → auto-pick. Гейт по `restoring` (реальные ключи), а НЕ
    // по факту строки server_keys — она могла появиться от upsert настроек без ключей. #7.
    const savedPorts = repo.getEndpointPorts(s.host);
    const reqPortXray = Number(req_portXray);
    const reqPortAwg = Number(req_portAwg);
    let portXray = restoring ? savedPorts.xray : 443;
    let portAwg = restoring ? savedPorts.awg : 51820;
    if (Number.isInteger(reqPortXray) && reqPortXray >= 1 && reqPortXray <= 65535) portXray = reqPortXray;
    else if (!restoring && want.xray) portXray = await sshPickPort(s, 'tcp', 443).catch(() => 443);
    if (Number.isInteger(reqPortAwg) && reqPortAwg >= 1 && reqPortAwg <= 65535) portAwg = reqPortAwg;
    else if (!restoring && want.awg) portAwg = await sshPickPort(s, 'udp', undefined, [portXray]).catch(() => 51820);
    // Прокси-порты тоже авто-подбираем: раньше были жёстко 8080/1080/8443 без проверки
    // занятости → «наслаивались» на уже занятые на сервере порты. Теперь берём свободные,
    // исключая xray и друг друга (все TCP). При восстановлении — сохранённые.
    let portHttp = restoring ? savedPorts.http : 8080;
    let portSocks = restoring ? savedPorts.socks : 1080;
    let portHttps = restoring ? savedPorts.https : 8443;
    if (!restoring) {
      const usedTcp = [portXray];
      if (want.http || want.https) { portHttp = await sshPickPort(s, 'tcp', 8080, usedTcp).catch(() => 8080); usedTcp.push(portHttp); }
      if (want.socks) { portSocks = await sshPickPort(s, 'tcp', 1080, usedTcp).catch(() => 1080); usedTcp.push(portSocks); }
      if (want.https) { portHttps = await sshPickPort(s, 'tcp', 8443, usedTcp).catch(() => 8443); usedTcp.push(portHttps); }
    }
    // Подсказка «порт занят»: если админ задал порт ВРУЧНУЮ и он отличается от нашего
    // текущего — проверяем, что он свободен на сервере, иначе понятная ошибка (не молча
    // валимся при install). Свой текущий порт при переустановке «занят» нами — не проверяем.
    if (Number.isInteger(reqPortXray) && want.xray && !(restoring && portXray === savedPorts.xray) && !(await sshIsPortFree(s, 'tcp', portXray))) {
      throw new Error(`Порт Xray ${portXray} уже занят на сервере — выберите другой.`);
    }
    if (Number.isInteger(reqPortAwg) && want.awg && !(restoring && portAwg === savedPorts.awg) && !(await sshIsPortFree(s, 'udp', portAwg))) {
      throw new Error(`Порт AmneziaWG ${portAwg} уже занят на сервере — выберите другой.`);
    }

    const installed = want.xray || want.awg
      ? await sshInstallServer(s, {
          xray: want.xray, awg: want.awg,
          sni: restoring ? prev?.xraySni : undefined,
          realityPriv: restoring ? prev?.xrayRealityPrivKey : undefined,
          shortId: restoring ? prev?.xrayShortId : undefined,
          awgPriv: restoring ? prev?.awgServerPrivKey : undefined,
          awgParams,
          xrayPort: portXray, awgPort: portAwg,
        })
      : {};
    repo.saveEndpointPorts(s.host, { xray: portXray, awg: portAwg, http: portHttp, socks: portSocks, https: portHttps });
    saveServerKeys(s.host, {
      xrayRealityPrivKey: installed.realityPriv, xrayRealityPubKey: installed.realityPub,
      xrayShortId: installed.shortId, xraySni: installed.sni,
      awgServerPrivKey: installed.awgPriv, awgServerPubKey: installed.awgPub,
      awgParams: JSON.stringify(awgParams),
    });
    if (want.http || want.https || want.socks) {
      provisionStatus.set(serverId, { state: 'running', message: 'Устанавливаем прокси…', at: Date.now() });
      const proxy = await sshInstallProxies(s, { http: want.http, https: want.https, socks: want.socks, httpPort: portHttp, socksPort: portSocks, httpsPort: portHttps });
      saveServerProxy(s.host, proxy);
    }
    if (restoring) {
      const devs = repo.getServerDevicesForResync(s.id).map((d) => ({
        name: d.name, protocol: d.protocol, uuid: d.uuid, awgPub: d.publicKey, clientIp: d.clientIp,
        psk: d.presharedKeyEnc ? decryptSecret(d.presharedKeyEnc) : null,
      }));
      if (devs.length) await sshResyncDevices(s, devs);
    }
    const proto = new Set(comps.filter((p) => ['xray', 'amneziawg', 'http', 'https', 'socks5'].includes(p)));
    // Не сбрасываем уже установленные прокси, если их не трогали в этой установке.
    for (const p of ['http', 'https', 'socks5']) if ((s.protocols as string[]).includes(p)) proto.add(p);
    const protocols = [...proto];
    repo.updateServerFields(s.id, { protocols: JSON.stringify(protocols), agent: 'online', endpoint_ok: 1, last_sync_at: repo.nowIso() });
    repo.addLog(`${restoring ? 'Переустановлен' : 'Установлен'} сервер «${s.name}» (${protocols.join(', ')})`);
    provisionStatus.set(serverId, { state: 'done', message: 'Установка завершена.', restored: restoring, at: Date.now() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Ошибка установки.';
    repo.addJobError(s.name, `Установка: ${msg}`); // видно на «Обзоре»
    provisionStatus.set(serverId, { state: 'error', message: msg, at: Date.now() });
  }
}

// Если для домена уже есть ключи — восстановление (старые конфиги живут). Асинхронно.
router.post('/api/admin/servers/:id/provision', requireAdmin, async (req, res) => {
  const s = repo.getServer(req.params.id!);
  if (!s) return res.status(404).json(err('not_found', 'Сервер не найден.'));
  if (!(await sshHasSshAccess(s.id))) return res.status(400).json(err('ssh', 'Для сервера не задан SSH-доступ.'));
  if (provisionStatus.get(s.id)?.state === 'running') return res.json({ ok: true, running: true });
  const comps: string[] = Array.isArray(req.body?.components) ? req.body.components : ['xray', 'amneziawg'];
  // Явные порты из формы (режим «Вручную»). Пусто → auto/сохранённые в runProvision.
  const ports = { xray: Number(req.body?.portXray) || undefined, awg: Number(req.body?.portAwg) || undefined };
  provisionStatus.set(s.id, { state: 'running', message: 'Запуск установки…', at: Date.now() });
  void runProvision(s.id, comps, ports); // не ждём — статус опрашивается отдельно
  res.json({ ok: true, running: true });
});

router.get('/api/admin/servers/:id/provision-status', requireAdmin, (req, res) => {
  res.json(provisionStatus.get(req.params.id!) ?? { state: 'idle', message: '' });
});

// Сменить reality-SNI на сервере (без переустановки). vk.com режется DPI —
// переводим на cdn.dodostatic.net. Ключи не трогаются, UUID остаются валидными;
// клиентские ссылки обновляет миграция БД.
router.post('/api/admin/servers/:id/reality-sni', requireAdmin, async (req, res) => {
  const s = repo.getServer(req.params.id!);
  if (!s) return res.status(404).json(err('not_found', 'Сервер не найден.'));
  if (!(await sshHasSshAccess(s.id))) return res.status(400).json(err('ssh', 'Для сервера не задан SSH-доступ.'));
  try {
    await sshSetXraySni(s);
    saveServerKeys(s.host, { xraySni: REALITY_SNI });
    repo.addLog(`reality-SNI на «${s.name}» → ${REALITY_SNI}`);
    res.json({ ok: true, sni: REALITY_SNI });
  } catch (e) {
    res.status(400).json(err('server', e instanceof Error ? e.message : 'Не удалось сменить SNI.'));
  }
});

// Полное удаление ПО с сервера (xray/awg/прокси). Пользователи и подписки в панели не трогаются.
router.post('/api/admin/servers/:id/uninstall', requireAdmin, async (req, res) => {
  const s = repo.getServer(req.params.id!);
  if (!s) return res.status(404).json(err('not_found', 'Сервер не найден.'));
  if (!(await sshHasSshAccess(s.id))) return res.status(400).json(err('ssh', 'Для сервера не задан SSH-доступ.'));
  try {
    await sshUninstallServer(s);
    // purgeKeys: полностью забыть ключи домена (иначе они хранятся для восстановления).
    if (req.body?.purgeKeys) deleteServerKeys(s.host);
    repo.updateServerFields(s.id, { agent: 'never', endpoint_ok: 0, protocols: '[]' });
    repo.addLog(`Удалено ПО с сервера «${s.name}»${req.body?.purgeKeys ? ' (с ключами)' : ''}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json(err('server', e instanceof Error ? e.message : 'Ошибка удаления.'));
  }
});

// Реальная установка прокси-комплекта (HTTP/HTTPS/SOCKS) на сервер по SSH.
router.post('/api/admin/servers/:id/install-proxies', requireAdmin, async (req, res) => {
  const s = repo.getServer(req.params.id!);
  if (!s) return res.status(404).json(err('not_found', 'Сервер не найден.'));
  if (!(await sshHasSshAccess(s.id))) return res.status(400).json(err('ssh', 'Для сервера не задан SSH-доступ.'));
  const b = req.body ?? {};
  const want = { http: !!b.http, https: !!b.https, socks: !!b.socks };
  if (!want.http && !want.https && !want.socks) return res.status(400).json(err('validation', 'Выберите хотя бы один тип прокси.'));
  try {
    const p = await sshInstallProxies(s, want);
    saveServerProxy(s.host, p);
    // Отмечаем протоколы как установленные.
    const cur = new Set(s.protocols as string[]);
    if (want.http) cur.add('http');
    if (want.https) cur.add('https');
    if (want.socks) cur.add('socks5');
    repo.updateServerFields(s.id, { protocols: JSON.stringify([...cur]) });
    repo.addLog(`Установлены прокси на «${s.name}»`);
    res.json({ ok: true, proxy: p, server: repo.getServer(s.id) });
  } catch (e) {
    res.status(400).json(err('server', e instanceof Error ? e.message : 'Ошибка установки прокси.'));
  }
});

// Получить конфиг прокси сервера (логин/пароль/порты) — для показа админу.
router.get('/api/admin/servers/:id/proxy', requireAdmin, (req, res) => {
  const s = repo.getServer(req.params.id!);
  if (!s) return res.status(404).json(err('not_found', 'Сервер не найден.'));
  res.json({ proxy: getServerProxy(s.host), host: s.host });
});

router.post('/api/admin/servers/:id/auto-issue', requireAdmin, (req, res) => {
  const on = !!req.body?.on;
  res.json(repo.updateServerFields(req.params.id!, { auto_issue: on ? 1 : 0 }));
});

// По умолчанию — ОТВЯЗАТЬ физический сервер, СОХРАНИВ endpoint (домен/порты/ключи/
// конфиги живут; можно позже подключить новый сервер на тот же домен). Полное удаление
// endpoint'а с ключами — только при явном purgeEndpoint=true (опасное действие).
router.delete('/api/admin/servers/:id', requireAdmin, (req, res) => {
  const s = repo.getServer(req.params.id!);
  if (!s) return res.status(404).json(err('not_found', 'Сервер не найден.'));
  const purge = req.body?.purgeEndpoint === true;
  if (purge) {
    repo.deleteServer(s.id);
    repo.deleteEndpointProfile(s.host);
    deleteServerKeys(s.host);
    repo.addLog(`Полностью удалён сервер и endpoint «${s.name}» (${s.host}) — старые конфиги больше не работают`);
  } else {
    repo.detachServer(s.id);
    repo.addLog(`Сервер «${s.name}» отвязан (endpoint сохранён: домен/порты/ключи/конфиги живут)`);
  }
  res.json({ ok: true, purged: purge });
});

// Профиль endpoint'а по домену — для мастера (нашли сохранённую конфигурацию?).
router.get('/api/admin/endpoint-profile', requireAdmin, (req, res) => {
  const host = String(req.query.host ?? '').trim();
  if (!host) return res.status(400).json(err('validation', 'Не указан host.'));
  res.json({ profile: repo.getEndpointProfile(host), config: repo.getEndpointConfig(host) });
});

// Пер-серверные настройки генерации конфига (обход/LAN/фоллбэк). null-поле = наследовать
// глобальную настройку. Хранится по домену (переживает замену физического сервера).
router.put('/api/admin/servers/:id/endpoint-config', requireAdmin, (req, res) => {
  const s = repo.getServer(req.params.id!);
  if (!s) return res.status(404).json(err('not_found', 'Сервер не найден.'));
  const b = req.body ?? {};
  const patch: Parameters<typeof repo.setEndpointConfig>[1] = {};
  if ('xrayWhitelist' in b) patch.xrayWhitelist = b.xrayWhitelist === null ? null : !!b.xrayWhitelist;
  if ('lanAccess' in b) patch.lanAccess = b.lanAccess === null ? null : !!b.lanAccess;
  if ('whitelistDomains' in b) patch.whitelistDomains = b.whitelistDomains === null ? null : (Array.isArray(b.whitelistDomains) ? b.whitelistDomains.map((x: unknown) => String(x).trim()).filter(Boolean) : null);
  if ('fallbackTypes' in b) patch.fallbackTypes = b.fallbackTypes === null ? null : (Array.isArray(b.fallbackTypes) ? b.fallbackTypes.filter((x: unknown) => x === 'https' || x === 'http' || x === 'socks') : null);
  repo.setEndpointConfig(s.host, patch);
  res.json({ ok: true, config: repo.getEndpointConfig(s.host) });
});

// Смена публичного порта БЕЗ поломки старых конфигов: старый порт становится legacy
// (iptables REDIRECT old→new), новый — primary. Старые выданные конфиги продолжают
// работать через alias. keepLegacy=false — сразу без совместимости (старые отвалятся).
router.post('/api/admin/servers/:id/change-port', requireAdmin, async (req, res) => {
  const s = repo.getServer(req.params.id!);
  if (!s) return res.status(404).json(err('not_found', 'Сервер не найден.'));
  const comp = String(req.body?.component ?? '');
  const newPort = Number(req.body?.port);
  const keepLegacy = req.body?.keepLegacy !== false;
  if (comp !== 'xray' && comp !== 'awg') return res.status(400).json(err('validation', 'component: xray|awg.'));
  if (!Number.isInteger(newPort) || newPort < 1 || newPort > 65535) return res.status(400).json(err('validation', 'Некорректный порт.'));
  const proto = comp === 'xray' ? 'tcp' : 'udp';
  const protoKey = comp === 'xray' ? 'xray' : 'awg';
  const oldPort = comp === 'xray' ? s.ports!.xray : s.ports!.awg;
  const otherPort = comp === 'xray' ? s.ports!.awg : s.ports!.xray;
  if (oldPort === newPort) return res.json({ ok: true, unchanged: true });
  // Не даём конфликтующий порт (SSH/ACME/встречный компонент). #11
  if ([22, 80, otherPort].includes(newPort)) return res.status(400).json(err('validation', `Порт ${newPort} занят (SSH/80/другой компонент). Выберите другой.`));
  try {
    // Переустанавливаем службу на новом порту (ключи/uuid сохраняются — из профиля).
    await runProvision(s.id, s.protocols as string[], comp === 'xray' ? { xray: newPort } : { awg: newPort });
    // runProvision ГАСИТ ошибки внутрь provisionStatus и НЕ бросает. Если переустановка
    // на новом порту не удалась (порт занят/сбой install) — в БД остаётся СТАРЫЙ порт,
    // подписка ещё отдаёт старый, а мы НЕ должны ставить REDIRECT старый→новый (увёл бы
    // клиентов на мёртвый порт). Проверяем успех и при провале выходим с ошибкой. #HIGH
    const pst = provisionStatus.get(s.id);
    if (pst?.state !== 'done') throw new Error(pst?.message || 'Переустановка на новом порту не удалась — порт не изменён.');
    // REDIRECT в iptables НЕ цепочечный, поэтому все существующие legacy-порты
    // пере-указываем на НОВЫЙ primary (снимаем старое правило по сохранённому target,
    // ставим port→newPort), иначе самые старые конфиги отвалились бы. #3/#5
    for (const l of repo.getLegacyPorts(s.host).filter((x) => x.proto === protoKey)) {
      await sshSetPortAlias(s, proto, l.port, l.target, false);
      await sshSetPortAlias(s, proto, l.port, newPort, true);
    }
    repo.retargetLegacyPorts(s.host, protoKey, newPort);
    // Только что заменённый primary oldPort сам становится legacy → newPort.
    if (keepLegacy) {
      await sshSetPortAlias(s, proto, oldPort, newPort, true);
      repo.addLegacyPort(s.host, protoKey, oldPort, newPort);
    }
    repo.addLog(`Сервер «${s.name}»: порт ${comp} ${oldPort} → ${newPort}${keepLegacy ? ` (старый ${oldPort} оставлен для совместимости)` : ''}`);
    res.json({ ok: true, oldPort, newPort, legacyKept: keepLegacy });
  } catch (e) {
    res.status(400).json(err('server', e instanceof Error ? e.message : 'Ошибка смены порта.'));
  }
});

// Перевести сервер на вход по SSH-ключу (key-only) БЕЗОПАСНО: ставим ключ → тест-вход
// ключом → и только при успехе отключаем пароль. Приватный ключ шифруется, наружу не отдаётся.
router.post('/api/admin/servers/:id/harden-ssh', requireAdmin, async (req, res) => {
  const s = repo.getServer(req.params.id!);
  if (!s) return res.status(404).json(err('not_found', 'Сервер не найден.'));
  const privateKey = String(req.body?.privateKey ?? '').trim();
  if (!privateKey || !/PRIVATE KEY/.test(privateKey)) return res.status(400).json(err('validation', 'Вставьте приватный SSH-ключ (OpenSSH/PEM).'));
  try {
    const r = await sshHardenToKey(s, privateKey);
    repo.addLog(`Сервер «${s.name}»: включён вход по SSH-ключу${r.passwordDisabled ? ', парольная аутентификация отключена' : ' (пароль отключить не удалось подтвердить — проверьте sshd_config)'}`);
    res.json({ ok: true, publicKey: r.publicKey, passwordDisabled: r.passwordDisabled });
  } catch (e) {
    res.status(400).json(err('server', e instanceof Error ? e.message : 'Не удалось перевести на ключ.'));
  }
});

// Отключить legacy-порт (после отключения старые конфиги через него перестанут работать).
router.post('/api/admin/servers/:id/disable-legacy', requireAdmin, async (req, res) => {
  const s = repo.getServer(req.params.id!);
  if (!s) return res.status(404).json(err('not_found', 'Сервер не найден.'));
  const proto0 = String(req.body?.proto ?? ''); // 'xray' | 'awg'
  const port = Number(req.body?.port);
  if (proto0 !== 'xray' && proto0 !== 'awg') return res.status(400).json(err('validation', 'proto: xray|awg.'));
  const proto = proto0 === 'awg' ? 'udp' : 'tcp';
  if (!Number.isInteger(port) || port < 1 || port > 65535) return res.status(400).json(err('validation', 'Некорректный порт.'));
  // Снимаем правило по СОХРАНЁННОМУ target алиаса (а не по текущему primary — они
  // совпадают после retarget, но так надёжнее). #3
  const legacy = repo.getLegacyPorts(s.host).find((l) => l.proto === (proto0 === 'awg' ? 'awg' : 'xray') && l.port === port);
  const target = legacy?.target ?? (proto0 === 'awg' ? s.ports!.awg : s.ports!.xray);
  try {
    await sshSetPortAlias(s, proto, port, target, false);
    repo.removeLegacyPort(s.host, (proto0 === 'awg' ? 'awg' : 'xray'), port);
    repo.addLog(`Сервер «${s.name}»: отключён legacy-порт ${proto0}:${port}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json(err('server', e instanceof Error ? e.message : 'Ошибка.'));
  }
});

// ── admin: telegram ──
router.put('/api/admin/telegram', requireAdmin, (req, res) => {
  const b = req.body ?? {};
  const cur = repo.getTelegram();
  const next: TelegramSettings = {
    ...cur,
    enabled: !!b.enabled,
    mode: b.mode === 'webhook' ? 'webhook' : 'polling',
    proxyOn: !!b.proxyOn,
    proxySource: b.proxySource === 'server' ? 'server' : 'manual',
    proxyServerId: b.proxyServerId ?? null,
    // socks5 undici ProxyAgent не умеет — раньше он молча сохранялся, а прокси
    // отключался (прямой заблокированный коннект). Сводим к рабочему http.
    proxyType: b.proxyType === 'https' ? 'https' : 'http',
    proxyHost: String(b.proxyHost ?? ''),
    proxyPort: String(b.proxyPort ?? ''),
    proxyLogin: String(b.proxyLogin ?? ''),
    template: String(b.template ?? cur.template),
  };
  if (b.token) {
    // Токен шифруется и хранится отдельно; наружу — только маска.
    const enc = encryptSecret(String(b.token));
    (next as unknown as { tokenEnc?: string }).tokenEnc = enc; // сохранится в JSON; наружу не отдаём
    next.tokenMasked = maskTail(String(b.token));
    // Новый токен → возможно, ДРУГОЙ бот. Сбрасываем сохранённый username, иначе
    // deep-link «Привязать Telegram» и кнопка в кабинете вели бы на старого бота.
    // pollLoop перечитает username через getMe.
    (next as unknown as { botUsername?: string }).botUsername = undefined;
  }
  if (b.proxyPass) {
    (next as unknown as { proxyPassEnc?: string }).proxyPassEnc = encryptSecret(String(b.proxyPass));
    next.proxyPassSet = true;
  }
  next.status = next.enabled ? (next.tokenMasked ? 'running' : 'stopped') : 'stopped';
  repo.saveTelegramRaw(next);
  restartBot(); // применяем новые настройки к боту (вкл/выкл, токен, прокси)
  // Ответ без секретных полей.
  const { tokenEnc: _t, proxyPassEnc: _p, ...safe } = next as TelegramSettings & { tokenEnc?: string; proxyPassEnc?: string };
  res.json(safe);
});

router.post('/api/admin/telegram/test', requireAdmin, async (req, res) => {
  // Если новый токен не введён — проверяем СОХРАНЁННЫЙ (расшифровываем).
  let token = String(req.body?.token ?? '').trim();
  if (!token) {
    const enc = repo.getTelegramTokenEnc();
    if (enc) {
      try {
        token = decryptSecret(enc);
      } catch {
        /* игнор — упадёт на валидации ниже */
      }
    }
  }
  if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token))
    return res.json({ ok: false, message: 'Токен не задан или неверного формата (ожидается 123456:AA...).' });
  const proxyUrl = resolveTgProxyUrl();
  try {
    const me = await tgApi<{ username?: string }>('getMe', {}, token);
    if (me?.username) return res.json({ ok: true, message: `Бот @${me.username} отвечает${proxyUrl ? ' (через прокси)' : ''}.` });
    return res.json({ ok: false, message: 'Telegram не вернул данные бота.' });
  } catch (e) {
    const msg = e instanceof Error ? e.message : '';
    const timedOut = /timeout|aborted|fetch failed/i.test(msg);
    if (/unauthorized/i.test(msg)) return res.json({ ok: false, message: 'Telegram отклонил токен (Unauthorized). Проверьте токен.' });
    return res.json({
      ok: false,
      message: proxyUrl
        ? 'Не удалось связаться с Telegram через прокси. Проверьте, что прокси на сервере работает.'
        : timedOut
          ? 'Telegram недоступен напрямую с сервера (вероятно, заблокирован). Включите прокси для бота и повторите.'
          : `Ошибка связи с Telegram: ${msg}`,
    });
  }
});

// ── admin: apps ──
router.put('/api/admin/apps', requireAdmin, (req, res) => {
  const apps = Array.isArray(req.body?.apps) ? req.body.apps : [];
  const saved = repo.replaceApps(apps);
  // Файлы, на которые больше нет ссылок в каталоге, удаляем с диска.
  try {
    appFiles.cleanupOrphans();
  } catch {
    /* чистка файлов не критична для сохранения каталога */
  }
  res.json(saved);
});

// Стрим-загрузка файла приложения на диск (Content-Type: application/octet-stream,
// тело = сырые байты; express.json его не трогает). Имя оригинала — в ?name=.
router.post('/api/admin/apps/:id/:platform/file', requireAdmin, async (req, res) => {
  const app = repo.getApp(String(req.params.id));
  if (!app) return res.status(404).json(err('not_found', 'Приложение не найдено.'));
  const platform = String(req.params.platform);
  if (!app.platforms.some((p) => p.platform === platform))
    return res.status(400).json(err('validation', 'У приложения нет такой платформы.'));
  const origName = String(req.query.name ?? '').trim() || `${app.id}-${platform}`;
  try {
    const { name, size } = await appFiles.saveUpload(app.id, platform, origName, req);
    const updated = repo.setAppDownload(app.id, platform, name, size);
    repo.addLog(`Загружен файл приложения «${app.client}» (${platform}, ${(size / 1048576).toFixed(1)} МБ)`);
    res.json(updated);
  } catch (e) {
    res.status(500).json(err('server', e instanceof Error ? e.message : 'Не удалось сохранить файл.'));
  }
});

// Снять файл с платформы (удалить с диска + из каталога).
router.delete('/api/admin/apps/:id/:platform/file', requireAdmin, (req, res) => {
  const appId = String(req.params.id);
  const platform = String(req.params.platform);
  appFiles.removeFiles(appId, platform);
  const updated = repo.setAppDownload(appId, platform, null, null);
  res.json(updated ?? { ok: true });
});

// Публичное скачивание файла приложения (стримом с диска). Файлы — общедоступный
// софт (Happ/NekoBox/…), секретов нет; отдаём без авторизации, как страницу подписки.
router.get('/apps/file/:appId/:platform', (req, res) => {
  const app = repo.getApp(String(req.params.appId));
  const entry = app?.platforms.find((p) => p.platform === String(req.params.platform));
  if (!app || !entry?.downloadName) return res.status(404).send('');
  const full = appFiles.filePath(app.id, entry.platform, entry.downloadName);
  if (!full) return res.status(404).send('');
  appFiles.streamDownload(res, full, entry.downloadName);
});

// ── admin: умная маршрутизация ──
const ROUTING_MAX_BYTES = 8 * 1024 * 1024;
router.get('/api/admin/routing', requireAdmin, (_req, res) => {
  res.json({ files: repo.listRoutingFiles() });
});
router.get('/api/admin/routing/:name', requireAdmin, (req, res) => {
  const f = repo.getRoutingFull(String(req.params.name));
  if (!f) return res.status(404).json(err('not_found', 'Файл не найден.'));
  res.json(f);
});
router.put('/api/admin/routing/:name', requireAdmin, (req, res) => {
  const name = String(req.params.name);
  if (!repo.getRoutingRow(name)) return res.status(404).json(err('not_found', 'Файл не найден.'));
  const content = typeof req.body?.content === 'string' ? req.body.content : '';
  try {
    JSON.parse(content);
  } catch {
    return res.status(400).json(err('validation', 'Содержимое не является валидным JSON.'));
  }
  if (Buffer.byteLength(content, 'utf8') > ROUTING_MAX_BYTES)
    return res.status(413).json(err('too_large', 'Файл больше 8 МБ.'));
  const { meta, changed } = repo.saveRoutingContent(name, content);
  if (changed) repo.addLog(`Умная маршрутизация: сохранён ${name}.json (v${meta.version})`);
  res.json({ meta, changed });
});
router.put('/api/admin/routing/:name/source', requireAdmin, (req, res) => {
  const name = String(req.params.name);
  if (!repo.getRoutingRow(name)) return res.status(404).json(err('not_found', 'Файл не найден.'));
  const b = req.body ?? {};
  const patch: { mode?: 'local' | 'mirror'; sourceUrl?: string; autoSync?: boolean } = {};
  if (b.mode !== undefined) patch.mode = b.mode === 'mirror' ? 'mirror' : 'local';
  if (b.sourceUrl !== undefined) {
    const u = String(b.sourceUrl).trim().slice(0, 2048);
    if (u && !/^https?:\/\//i.test(u))
      return res.status(400).json(err('validation', 'URL должен начинаться с http:// или https://.'));
    patch.sourceUrl = u;
  }
  if (b.autoSync !== undefined) patch.autoSync = !!b.autoSync;
  res.json({ meta: repo.saveRoutingSource(name, patch) });
});
router.post('/api/admin/routing/:name/check', requireAdmin, async (req, res) => {
  const name = String(req.params.name);
  if (!repo.getRoutingRow(name)) return res.status(404).json(err('not_found', 'Файл не найден.'));
  try {
    const result = await checkMirror(name as 'upstream' | 'sites' | 'apps', { apply: false });
    res.json(result);
  } catch (e) {
    res.status(400).json(err('server', e instanceof Error ? e.message : 'Ошибка проверки.'));
  }
});

// ── admin: канал обновлений NoVPN Desktop ──
router.get('/api/admin/desktop', requireAdmin, (_req, res) => {
  res.json({ current: currentManifest(), config: getDesktopConfig(), versions: listVersions() });
});
router.put('/api/admin/desktop/config', requireAdmin, async (req, res) => {
  const b = req.body ?? {};
  const patch: Partial<DesktopChannelConfig> = {};
  if (b.mode !== undefined) patch.mode = b.mode === 'pin' || b.mode === 'manual' ? b.mode : 'auto';
  if (b.pinnedVersion !== undefined) patch.pinnedVersion = b.pinnedVersion ? String(b.pinnedVersion) : null;
  const cfg = setDesktopConfig(patch);
  // Применяем сразу: pin → выложить из архива, auto → подтянуть свежую версию.
  let applied: Awaited<ReturnType<typeof mirrorCheck>>;
  try {
    applied = await mirrorCheck({ force: true });
  } catch (e) {
    applied = { ok: false, action: 'error', error: e instanceof Error ? e.message : 'ошибка' };
  }
  res.json({ config: cfg, applied, current: currentManifest(), versions: listVersions() });
});
// Загрузка релиза разработчиком: тело = сырой zip (application/zip|octet-stream).
router.post('/api/admin/desktop/upload', requireAdmin, express.raw({ type: () => true, limit: 210 * 1024 * 1024 }), (req, res) => {
  const buf = req.body as unknown;
  if (!Buffer.isBuffer(buf) || buf.length === 0) return res.status(400).json(err('validation', 'Пустое тело загрузки.'));
  const r = acceptUpload(buf);
  if (!r.ok) return res.status(400).json(err('validation', r.error ?? 'Не удалось принять релиз.'));
  repo.addLog(`NoVPN Desktop: загружен релиз ${r.version} через админку`);
  res.json({ ok: true, version: r.version, current: currentManifest(), versions: listVersions() });
});
router.post('/api/admin/desktop/check', requireAdmin, async (_req, res) => {
  try {
    res.json(await mirrorCheck({ force: true }));
  } catch (e) {
    res.status(400).json(err('server', e instanceof Error ? e.message : 'Ошибка проверки.'));
  }
});

// ── admin: settings ──
router.put('/api/admin/settings', requireAdmin, (req, res) => {
  // Мержим поверх текущих: частичное тело не должно обнулять несвязанные поля
  // (раньше сохранялось body как есть — полная перезапись). Плюс лёгкая нормализация
  // числовых (>=0) и списочных полей, чтобы битый ввод не портил конфиг (#19).
  const patch = (req.body ?? {}) as Partial<AppSettings>;
  const cur = repo.getSettings();
  const next: AppSettings = { ...cur, ...patch };
  const clamp = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : d);
  next.codeAttempts = clamp(next.codeAttempts, cur.codeAttempts ?? 5);
  next.codeCooldownMin = clamp(next.codeCooldownMin, cur.codeCooldownMin ?? 15);
  next.inactiveDisableDays = clamp(next.inactiveDisableDays, cur.inactiveDisableDays ?? 0);
  next.codeLoginDays = clamp(next.codeLoginDays, cur.codeLoginDays ?? 15);
  if (next.whitelistDomains != null && !Array.isArray(next.whitelistDomains)) next.whitelistDomains = cur.whitelistDomains;
  if (typeof next.brandName === 'string') next.brandName = next.brandName.slice(0, 64).trim();
  next.lanAccess = next.lanAccess === true;
  next.xrayWhitelist = next.xrayWhitelist !== false;
  res.json(repo.saveSettings(next));
});

// ── admin: графики истории + здоровье/аптайм серверов ──
router.get('/api/admin/stats', requireAdmin, (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
  res.json({ days, series: repo.getStatsSeries(days * 86400000) });
});
router.get('/api/admin/health', requireAdmin, (_req, res) => {
  const servers = repo.listServers().map((s) => {
    const online = s.agent === 'online';
    const u24 = repo.serverUptime(s.id, 86400000, online);
    const u7 = repo.serverUptime(s.id, 7 * 86400000, online);
    return {
      id: s.id, name: s.name, country: s.country ?? null, online, lastSyncAt: s.lastSyncAt ?? null, endpointOk: s.endpointOk,
      uptime24h: Math.round(u24.uptimePct * 10) / 10, uptime7d: Math.round(u7.uptimePct * 10) / 10,
      lastChangeAt: u24.lastChangeAt,
    };
  });
  res.json({ servers });
});

// ── admin: бэкап базы ──
// Скачать зашифрованный паролем бэкап. Файл самодостаточен: восстанавливается
// на новой панели с любым ENCRYPTION_KEY.
router.post('/api/admin/backup/export', requireAdmin, (req, res) => {
  try {
    const password = String(req.body?.password ?? '');
    const buf = createBackup(password);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="novpn-backup-${stamp}.novpnbak"`);
    repo.addLog('Скачан бэкап базы');
    res.send(buf);
  } catch (e) {
    res.status(400).json(err('validation', e instanceof Error ? e.message : 'Не удалось создать бэкап.'));
  }
});

// Восстановить базу из бэкапа. Файл приходит как base64 в JSON (чтобы не тащить
// multipart). После успеха панель перезапускается и поднимается уже с новой базой.
router.post('/api/admin/backup/restore', requireAdmin, (req, res) => {
  try {
    const password = String(req.body?.password ?? '');
    const b64 = String(req.body?.file ?? '');
    if (!b64) return res.status(400).json(err('validation', 'Файл не передан.'));
    const buf = Buffer.from(b64, 'base64');
    const { sqlite, encKey } = decryptBackup(buf, password);
    const { users } = restoreBackup(sqlite, encKey);
    repo.addLog(`Восстановление из бэкапа (${users} пользователей) — перезапуск`);
    res.json({ ok: true, users });
    // Даём ответу уйти и перезапускаемся: db.ts подхватит .pending-restore.
    setTimeout(() => process.exit(0), 400);
  } catch (e) {
    res.status(400).json(err('validation', e instanceof Error ? e.message : 'Не удалось восстановить.'));
  }
});
