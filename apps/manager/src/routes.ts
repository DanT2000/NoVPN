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
import { sshHasSshAccess, sshCreateXray, sshCreateAwg, sshRevokeXray, sshRevokeAwg, sshInstallProxies, sshInstallServer, sshUninstallServer, sshResyncDevices, sshProbe, sshReadAwgParams, genAwgParams } from './services/sshServer.js';
import type { AwgParams } from './services/sshServer.js';
import { saveServerKeys, saveServerProxy, getServerProxy, getServerKeys, deleteServerKeys } from './services/keyvault.js';
import { decryptSecret, encryptSecret, maskTail, randomToken } from './lib/crypto.js';
import { createXrayCfg, createAwgCfg, issueForUser } from './services/issue.js';
import { resolveTgProxyUrl, restartBot, tgApi } from './services/telegram.js';
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
  const protocols = components.filter((p) => p === 'xray' || p === 'amneziawg');
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

async function runProvision(serverId: string, comps: string[]): Promise<void> {
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
    if (!awgParams) awgParams = genAwgParams();

    const installed = want.xray || want.awg
      ? await sshInstallServer(s, {
          xray: want.xray, awg: want.awg,
          sni: restoring ? prev?.xraySni : undefined,
          realityPriv: restoring ? prev?.xrayRealityPrivKey : undefined,
          shortId: restoring ? prev?.xrayShortId : undefined,
          awgPriv: restoring ? prev?.awgServerPrivKey : undefined,
          awgParams,
        })
      : {};
    saveServerKeys(s.host, {
      xrayRealityPrivKey: installed.realityPriv, xrayRealityPubKey: installed.realityPub,
      xrayShortId: installed.shortId, xraySni: installed.sni,
      awgServerPrivKey: installed.awgPriv, awgServerPubKey: installed.awgPub,
      awgParams: JSON.stringify(awgParams),
    });
    if (want.http || want.https || want.socks) {
      provisionStatus.set(serverId, { state: 'running', message: 'Устанавливаем прокси…', at: Date.now() });
      const proxy = await sshInstallProxies(s, { http: want.http, https: want.https, socks: want.socks });
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
  provisionStatus.set(s.id, { state: 'running', message: 'Запуск установки…', at: Date.now() });
  void runProvision(s.id, comps); // не ждём — статус опрашивается отдельно
  res.json({ ok: true, running: true });
});

router.get('/api/admin/servers/:id/provision-status', requireAdmin, (req, res) => {
  res.json(provisionStatus.get(req.params.id!) ?? { state: 'idle', message: '' });
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
  res.json(repo.replaceApps(apps));
});

// ── admin: settings ──
router.put('/api/admin/settings', requireAdmin, (req, res) => {
  res.json(repo.saveSettings(req.body as AppSettings));
});
