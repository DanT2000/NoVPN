// Все HTTP-роуты. Пути совпадают с httpApi фронтенда.

import net from 'node:net';
import { Router } from 'express';
import type {
  AppSettings,
  IssueDeviceResult,
  PublicUserView,
  TelegramSettings,
  User,
} from '@novpn/shared';
import { config } from './config.js';
import { requireAdmin } from './middleware/auth.js';
import { agentService } from './services/agent.js';
import { sshHasSshAccess, sshCreateXray, sshCreateAwg, sshRevokeXray, sshRevokeAwg } from './services/sshServer.js';
import { saveServerKeys } from './services/keyvault.js';
import { decryptSecret, encryptSecret, maskTail, randomToken } from './lib/crypto.js';

// Выпуск конфига: по SSH (реальный сервер) или через mock-агент (dev).
async function createXrayCfg(server: import('@novpn/shared').Server, name: string) {
  return (await sshHasSshAccess(server.id)) ? sshCreateXray(server, name) : agentService.createXray(server, name);
}
async function createAwgCfg(server: import('@novpn/shared').Server, name: string) {
  return (await sshHasSshAccess(server.id)) ? sshCreateAwg(server, name) : agentService.createAmneziaWG(server, name);
}
import * as repo from './repo.js';

export const router = Router();

const err = (type: string, message: string) => ({ error: { type, message } });

function toPublicUserView(u: User): PublicUserView {
  return {
    id: u.id, name: u.name, code: u.code, deviceLimit: u.deviceLimit, expiresAt: u.expiresAt,
    trafficLimitGb: u.trafficLimitGb, trafficUsedGb: u.trafficUsedGb, allowedServers: u.allowedServers,
    defaultServerId: u.defaultServerId, allowedProtocols: u.allowedProtocols, isActive: u.isActive,
    telegramLinked: !!u.telegram,
  };
}

// ── health ──
router.get('/healthz', (_req, res) => res.json({ status: 'ok' }));

// ── bootstrap ──
router.get('/api/bootstrap', (_req, res) => res.json(repo.buildBootstrap()));

// ── public: check code ──
router.post('/api/public/check-code', (req, res) => {
  const code = String(req.body?.code ?? '');
  const u = repo.getUserByCode(code);
  if (!u) return res.json(err('not_found', 'Код не найден. Проверьте правильность ввода.'));
  if (!u.isActive) return res.json(err('disabled', 'Доступ отключён. Обратитесь к администратору.'));
  if (u.expiresAt && new Date(u.expiresAt) < new Date()) return res.json(err('expired', 'Срок действия доступа истёк.'));
  if (u.trafficLimitGb != null && u.trafficUsedGb >= u.trafficLimitGb)
    return res.json(err('traffic', 'Лимит трафика исчерпан. Обратитесь к администратору.'));
  if (u.deviceLimit != null && repo.countActiveDevices(u.id) >= u.deviceLimit)
    return res.json(err('devices', 'Лимит устройств по этому коду исчерпан.'));
  res.json({ user: toPublicUserView(u) });
});

async function issueForUser(user: User, name: string, serverId: string, protocol: 'xray' | 'amneziawg'): Promise<IssueDeviceResult> {
  const server = repo.getServer(serverId);
  if (!server) throw new Error('Сервер не найден.');
  if (!user.allowedServers.includes(serverId)) throw new Error('Сервер недоступен для этого пользователя.');
  if (!user.allowedProtocols.includes(protocol)) throw new Error('Протокол недоступен для этого пользователя.');
  if (!server.protocols.includes(protocol)) throw new Error('Сервер не поддерживает этот протокол.');

  if (protocol === 'xray') {
    const r = await createXrayCfg(server, name);
    const device = repo.insertDevice({ userId: user.id, name, serverId, protocol, uuid: r.uuid, publicKey: r.publicKey, link: r.link });
    repo.addHistory(user.id, `Выпущен конфиг «${name}» (Xray, ${server.name})`);
    return { device, link: r.link };
  }
  const r = await createAwgCfg(server, name);
  const device = repo.insertDevice({
    userId: user.id, name, serverId, protocol, publicKey: r.publicKey,
    privateKeyEnc: encryptSecret(r.privateKey), presharedKeyEnc: encryptSecret(r.presharedKey),
    clientIp: r.clientIp, conf: r.conf,
  });
  repo.addHistory(user.id, `Выпущен конфиг «${name}» (AmneziaWG, ${server.name})`);
  return {
    device, conf: r.conf, vpnKeyAvailable: false,
    vpnKeyNote: 'Официальный ключ vpn:// пока недоступен через текущий стек. Используйте .conf в совместимых приложениях.',
  };
}

// ── public: issue device ──
router.post('/api/public/devices', async (req, res) => {
  try {
    const { userId, name, serverId, protocol } = req.body ?? {};
    const u = repo.getUser(String(userId));
    if (!u) return res.status(404).json(err('not_found', 'Пользователь не найден.'));
    if (!u.isActive) return res.status(403).json(err('disabled', 'Доступ отключён.'));
    if (u.deviceLimit != null && repo.countActiveDevices(u.id) >= u.deviceLimit)
      return res.status(403).json(err('devices', 'Лимит устройств исчерпан.'));
    if (protocol !== 'xray' && protocol !== 'amneziawg') return res.status(400).json(err('validation', 'Неизвестный протокол.'));
    const out = await issueForUser(u, String(name || 'Устройство'), String(serverId), protocol);
    res.json(out);
  } catch (e) {
    res.status(400).json(err('server', e instanceof Error ? e.message : 'Ошибка выпуска конфига.'));
  }
});

router.post('/api/public/devices/:id/reissue', async (req, res) => {
  try {
    const d = repo.getDevice(req.params.id!);
    if (!d || !d.userId) return res.status(404).json(err('not_found', 'Устройство не найдено.'));
    const u = repo.getUser(d.userId);
    if (!u) return res.status(404).json(err('not_found', 'Пользователь не найден.'));
    if (d.protocol !== 'xray' && d.protocol !== 'amneziawg') return res.status(400).json(err('validation', 'Протокол не поддерживается.'));
    const server = repo.getServer(d.serverId)!;
    let out: IssueDeviceResult;
    if (d.protocol === 'xray') {
      const r = await createXrayCfg(server, d.name);
      const device = repo.updateDeviceFields(d.id, { is_active: 1, revoked_at: null, uuid: r.uuid, public_key: r.publicKey, link: r.link, conf: null })!;
      out = { device, link: r.link };
    } else {
      const r = await createAwgCfg(server, d.name);
      const device = repo.updateDeviceFields(d.id, {
        is_active: 1, revoked_at: null, public_key: r.publicKey, private_key_enc: encryptSecret(r.privateKey),
        preshared_key_enc: encryptSecret(r.presharedKey), client_ip: r.clientIp, conf: r.conf, link: null,
      })!;
      out = { device, conf: r.conf, vpnKeyAvailable: false, vpnKeyNote: 'Официальный ключ vpn:// пока недоступен.' };
    }
    repo.addHistory(u.id, `Перевыпущен конфиг «${d.name}»`);
    res.json(out);
  } catch (e) {
    res.status(400).json(err('server', e instanceof Error ? e.message : 'Ошибка.'));
  }
});

router.post('/api/public/devices/:id/revoke', async (req, res) => {
  const d = repo.getDevice(req.params.id!);
  if (!d) return res.status(404).json(err('not_found', 'Устройство не найдено.'));
  // Реальный отзыв на сервере (если сервер управляется по SSH).
  try {
    const row = repo.getDeviceRow(d.id);
    const server = repo.getServer(d.serverId);
    if (row && server && (await sshHasSshAccess(server.id))) {
      if (row.protocol === 'xray' && row.uuid) await sshRevokeXray(server, row.uuid);
      else if (row.protocol === 'amneziawg' && row.public_key) await sshRevokeAwg(server, row.public_key);
    }
  } catch {
    /* даже если на сервере не удалось — помечаем отозванным в панели */
  }
  repo.updateDeviceFields(d.id, { is_active: 0, revoked_at: repo.nowIso() });
  res.json({ ok: true });
});

router.delete('/api/public/devices/:id', (req, res) => {
  repo.deleteDevice(req.params.id!);
  res.json({ ok: true });
});

// ── admin: auth ──
router.post('/api/admin/login', (req, res) => {
  const { login, password } = req.body ?? {};
  const ok = login === config.adminLogin && password === config.adminPassword;
  if (ok) req.session.admin = true;
  res.json({ ok });
});
router.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ── admin: users ──
router.post('/api/admin/users', requireAdmin, (req, res) => {
  const b = req.body ?? {};
  const name = String(b.name ?? '').trim();
  if (!name) return res.status(400).json(err('validation', 'Укажите имя пользователя.'));
  let code = String(b.code ?? '');
  if (!/^\d{6}$/.test(code)) return res.status(400).json(err('validation', 'Код должен состоять из 6 цифр.'));
  if (repo.codeExists(code)) return res.status(400).json(err('validation', 'Такой код уже используется — выберите другой.'));
  const allowedServers: string[] = Array.isArray(b.allowedServers) ? b.allowedServers : [];
  if (allowedServers.length === 0) return res.status(400).json(err('validation', 'Выберите хотя бы один сервер.'));
  const allowedProtocols = (Array.isArray(b.allowedProtocols) ? b.allowedProtocols : []).filter((p: string) => p === 'xray' || p === 'amneziawg');
  if (allowedProtocols.length === 0) return res.status(400).json(err('validation', 'Выберите хотя бы один протокол.'));

  const u = repo.insertUser({
    name, comment: String(b.comment ?? ''), category: b.category ?? 'Общие', tags: Array.isArray(b.tags) ? b.tags : [],
    code, deviceLimit: b.deviceLimit ?? null, expiresAt: b.expiresAt ?? null, trafficLimitGb: b.trafficLimitGb ?? null,
    resetPolicy: b.resetPolicy === 'monthly' ? 'monthly' : 'never', allowedServers,
    defaultServerId: b.defaultServerId ?? null, allowedProtocols,
  });
  repo.addLog(`Создан пользователь «${u.name}»`);
  repo.addHistory(u.id, 'Пользователь создан');
  res.json(u);
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
  if (b.defaultServerId !== undefined) fields.default_server_id = b.defaultServerId;
  if (b.allowedProtocols !== undefined)
    fields.allowed_protocols = JSON.stringify((b.allowedProtocols as string[]).filter((p) => p === 'xray' || p === 'amneziawg'));
  res.json(repo.updateUserFields(u.id, fields));
});

router.post('/api/admin/users/:id/extend', requireAdmin, (req, res) => {
  const u = repo.getUser(req.params.id!);
  if (!u) return res.status(404).json(err('not_found', 'Пользователь не найден.'));
  const days = Number(req.body?.days ?? 0);
  const base = u.expiresAt && new Date(u.expiresAt) > new Date() ? new Date(u.expiresAt) : new Date();
  const expiresAt = new Date(base.getTime() + days * 86400000).toISOString();
  const updated = repo.updateUserFields(u.id, { expires_at: expiresAt });
  repo.addLog(`Продлён доступ «${u.name}» на ${days} дн`);
  res.json(updated);
});

router.post('/api/admin/users/:id/active', requireAdmin, (req, res) => {
  const u = repo.getUser(req.params.id!);
  if (!u) return res.status(404).json(err('not_found', 'Пользователь не найден.'));
  const active = !!req.body?.active;
  repo.updateUserFields(u.id, { is_active: active ? 1 : 0 });
  if (!active) {
    for (const d of repo.listDevices().filter((x) => x.userId === u.id && x.isActive))
      repo.updateDeviceFields(d.id, { is_active: 0, revoked_at: repo.nowIso() });
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
  const code = String(req.body?.code ?? '');
  if (!/^\d{6}$/.test(code)) return res.json(err('validation', 'Код — 6 цифр.'));
  if (repo.codeExists(code, u.id)) return res.json(err('validation', 'Такой код уже используется.'));
  res.json({ user: repo.updateUserFields(u.id, { code }) });
});

router.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  repo.softDeleteUser(req.params.id!);
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
  if (reachable) {
    audit.push({ name: 'Аудит ПО (ОС, Docker, протоколы)', ok: false, note: 'выполнит агент после установки по SSH' });
  }
  res.json({ ok: reachable, audit });
});

router.post('/api/admin/servers', requireAdmin, (req, res) => {
  const b = req.body ?? {};
  const components: string[] = Array.isArray(b.components) ? b.components : [];
  const protocols = components.filter((p) => p === 'xray' || p === 'amneziawg');
  // Одноразовый enrollment-token (для будущего агент-режима).
  const enrollToken = randomToken();
  // Если переданы серверные ключи — сервер уже установлен, панель работает по SSH.
  const hasKeys = !!(b.serverKeys && (b.serverKeys.awgServerPubKey || b.serverKeys.xrayRealityPubKey));
  const s = repo.insertServer({
    name: String(b.name ?? 'Сервер'), country: b.country ?? null, host: String(b.vpnHost || b.host || ''),
    protocols, agent: hasKeys ? 'online' : 'never', endpointOk: hasKeys,
    sshHost: b.host, sshPort: b.sshPort, sshUser: b.sshUser,
    sshPassEnc: b.secret && b.authMethod !== 'key' ? encryptSecret(String(b.secret)) : null,
    enrollSecretEnc: encryptSecret(enrollToken),
  });
  if (hasKeys) {
    saveServerKeys(s.host, {
      xrayRealityPubKey: b.serverKeys.xrayRealityPubKey,
      xrayShortId: b.serverKeys.xrayShortId,
      xraySni: b.serverKeys.xraySni,
      awgServerPubKey: b.serverKeys.awgServerPubKey,
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
  const vpnHost = b.vpnHost ?? b.host;
  if (vpnHost !== undefined && String(vpnHost).trim()) fields.host = String(vpnHost).trim();
  if (b.sshHost !== undefined) fields.ssh_host = b.sshHost;
  if (b.sshPort !== undefined) fields.ssh_port = Number(b.sshPort) || 22;
  if (b.sshUser !== undefined) fields.ssh_user = b.sshUser;
  // Новый SSH-пароль задаём только если пришёл непустой secret (иначе не трогаем).
  if (b.secret && b.authMethod !== 'key') fields.ssh_pass_enc = encryptSecret(String(b.secret));
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

router.post('/api/admin/servers/:id/default', requireAdmin, (req, res) => {
  res.json(repo.setServerDefault(req.params.id!));
});
router.post('/api/admin/servers/:id/auto-issue', requireAdmin, (req, res) => {
  const on = !!req.body?.on;
  res.json(repo.updateServerFields(req.params.id!, { auto_issue: on ? 1 : 0 }));
});

router.delete('/api/admin/servers/:id', requireAdmin, (req, res) => {
  const s = repo.getServer(req.params.id!);
  repo.deleteServer(req.params.id!);
  if (s) repo.addLog(`Удалён сервер «${s.name}»`);
  res.json({ ok: true });
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
    proxyType: b.proxyType === 'socks5' ? 'socks5' : b.proxyType === 'https' ? 'https' : 'http',
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
  }
  if (b.proxyPass) {
    (next as unknown as { proxyPassEnc?: string }).proxyPassEnc = encryptSecret(String(b.proxyPass));
    next.proxyPassSet = true;
  }
  next.status = next.enabled ? (next.tokenMasked ? 'running' : 'stopped') : 'stopped';
  repo.saveTelegramRaw(next);
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
  try {
    // Реальная проверка через Telegram Bot API.
    const r = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const d = (await r.json()) as { ok: boolean; result?: { username?: string }; description?: string };
    if (d.ok && d.result?.username) return res.json({ ok: true, message: `Бот @${d.result.username} отвечает.` });
    return res.json({ ok: false, message: `Telegram отклонил токен: ${d.description ?? 'неизвестная ошибка'}` });
  } catch {
    return res.json({ ok: false, message: 'Не удалось связаться с Telegram API (проверьте сеть/прокси).' });
  }
});

// ── admin: apps ──
router.put('/api/admin/apps', requireAdmin, (req, res) => {
  const apps = Array.isArray(req.body?.apps) ? req.body.apps : [];
  res.json(repo.replaceApps(apps));
});

// ── admin: settings ──
router.put('/api/admin/settings', requireAdmin, (req, res) => {
  res.json(repo.saveSettings(req.body as AppSettings));
});
