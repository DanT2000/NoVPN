// Импорт старой БД ZeroVPN (legacy) в новую схему. Главная цель — НЕ потерять
// старых пользователей: коды, UUID, public/preshared keys и тексты конфигов
// переносятся дословно. Импорт идемпотентен (повтор не дублирует — сопоставление
// по legacy_id, коду, uuid, public_key). Серверная конфигурация НЕ меняется.
//
// Запуск:  npm run import:legacy -- --from /path/to/old/database.sqlite
//          (цель — DATABASE_PATH новой установки)

import Database from 'better-sqlite3';
import { db } from '../db.js';
import { seedIfEmpty } from '../seed.js';
import { encryptSecret } from '../lib/crypto.js';
import { newId, nowIso } from '../repo.js';

export interface ImportResult {
  usersInserted: number;
  usersUpdated: number;
  devicesInserted: number;
  devicesUpdated: number;
  serverId: string;
  serverHost: string;
  legacyUsers: number;
  legacyDevices: number;
}

function normProto(p: string): string {
  const s = (p || '').toLowerCase();
  if (s.startsWith('xray') || s.includes('vless') || s.includes('reality')) return 'xray';
  if (s.includes('amnezia') || s.includes('awg') || s.includes('wireguard')) return 'amneziawg';
  return s || 'xray';
}

/** Публичный VPN-хост берём из текста конфига/ссылки старого устройства. */
function extractHost(...texts: Array<string | null | undefined>): string | null {
  for (const t of texts) {
    if (!t) continue;
    const vless = t.match(/vless:\/\/[^@]+@([^:/?#]+)/);
    if (vless?.[1]) return vless[1];
    const ep = t.match(/Endpoint\s*=\s*([^:\s]+):/i);
    if (ep?.[1]) return ep[1];
  }
  return null;
}

export function importLegacy(oldDbPath: string): ImportResult {
  seedIfEmpty();
  const old = new Database(oldDbPath, { readonly: true, fileMustExist: true });

  const legacyUsers = old.prepare('SELECT * FROM users').all() as any[];
  const legacyDevices = old.prepare('SELECT * FROM devices').all() as any[];

  // Хост импортированного сервера — из первого конфига, где он есть.
  let host: string | null = null;
  for (const d of legacyDevices) {
    host = extractHost(d.link_text, d.config_text);
    if (host) break;
  }
  host = host ?? 'imported.local';

  // Один импортированный сервер (в legacy у устройств нет привязки к серверу).
  let server = db.prepare('SELECT id, host FROM servers WHERE host = ? OR name = ?').get(host, 'Импортированный сервер') as any;
  if (!server) {
    const id = newId('s');
    db.prepare(
      `INSERT INTO servers(id,name,country,host,agent,endpoint_ok,service_health,protocols,is_default,auto_issue,
        last_sync_at,recommended,created_at)
       VALUES(?,?,?,?, 'never',1,'unknown',?,0,0,NULL,0,?)`,
    ).run(id, 'Импортированный сервер', null, host, JSON.stringify(['xray', 'amneziawg']), nowIso());
    server = { id, host };
  }
  const serverId: string = server.id;

  const result: ImportResult = {
    usersInserted: 0, usersUpdated: 0, devicesInserted: 0, devicesUpdated: 0,
    serverId, serverHost: host, legacyUsers: legacyUsers.length, legacyDevices: legacyDevices.length,
  };

  const getUserByLegacy = db.prepare('SELECT id FROM users WHERE legacy_id = ?');
  const getUserByCode = db.prepare('SELECT id FROM users WHERE code = ?');
  const getDevByLegacy = db.prepare('SELECT id FROM devices WHERE legacy_id = ?');
  const getDevByUuid = db.prepare('SELECT id FROM devices WHERE uuid IS NOT NULL AND uuid = ?');
  const getDevByPub = db.prepare('SELECT id FROM devices WHERE public_key IS NOT NULL AND public_key = ?');

  const tx = db.transaction(() => {
    // ── пользователи ──
    const legacyToNewUser = new Map<number, string>();
    for (const u of legacyUsers) {
      // протоколы пользователя — из его устройств
      const protos = new Set(
        legacyDevices.filter((d) => d.user_id === u.id).map((d) => normProto(d.protocol)),
      );
      const allowedProtocols = protos.size ? [...protos].filter((p) => p === 'xray' || p === 'amneziawg') : ['xray', 'amneziawg'];

      const existing = (getUserByLegacy.get(u.id) as any) ?? (getUserByCode.get(u.code) as any);
      if (existing) {
        db.prepare(
          `UPDATE users SET name=@name, comment=@comment, code=@code, device_limit=@dl, expires_at=@exp,
             is_active=@active, deleted_at=@deleted, legacy_id=@legacy, allowed_servers=@servers,
             default_server_id=@defsrv, allowed_protocols=@protos, updated_at=@now WHERE id=@id`,
        ).run({
          id: existing.id, name: u.name, comment: u.comment ?? '', code: u.code, dl: u.device_limit ?? null,
          exp: u.expires_at ?? null, active: u.is_active ?? 1, deleted: u.deleted_at ?? null, legacy: u.id,
          servers: JSON.stringify([serverId]), defsrv: serverId, protos: JSON.stringify(allowedProtocols), now: nowIso(),
        });
        legacyToNewUser.set(u.id, existing.id);
        result.usersUpdated++;
      } else {
        const id = newId('u');
        db.prepare(
          `INSERT INTO users(id,name,comment,category,tags,code,device_limit,expires_at,traffic_limit_gb,traffic_used_gb,
             reset_policy,allowed_servers,default_server_id,allowed_protocols,is_active,telegram,created_at,updated_at,
             last_activity_at,deleted_at,legacy_id)
           VALUES(@id,@name,@comment,'Импорт','[]',@code,@dl,@exp,NULL,0,'never',@servers,@defsrv,@protos,@active,NULL,
             @created,@now,NULL,@deleted,@legacy)`,
        ).run({
          id, name: u.name, comment: u.comment ?? '', code: u.code, dl: u.device_limit ?? null, exp: u.expires_at ?? null,
          servers: JSON.stringify([serverId]), defsrv: serverId, protos: JSON.stringify(allowedProtocols),
          active: u.is_active ?? 1, created: u.created_at ?? nowIso(), now: nowIso(), deleted: u.deleted_at ?? null, legacy: u.id,
        });
        legacyToNewUser.set(u.id, id);
        result.usersInserted++;
      }
    }

    // ── устройства ──
    for (const d of legacyDevices) {
      const userId = d.user_id != null ? legacyToNewUser.get(d.user_id) ?? null : null;
      const proto = normProto(d.protocol);
      const rb = Number(d.received_bytes ?? 0);
      const sb = Number(d.sent_bytes ?? 0);
      const monitoring = d.last_handshake || rb > 0 || sb > 0 ? 1 : 0;
      const privEnc = d.private_key ? encryptSecret(String(d.private_key)) : null;
      const pskEnc = d.preshared_key ? encryptSecret(String(d.preshared_key)) : null;

      const existing =
        (getDevByLegacy.get(d.id) as any) ??
        (d.uuid ? (getDevByUuid.get(d.uuid) as any) : null) ??
        (d.public_key ? (getDevByPub.get(d.public_key) as any) : null);

      const fields = {
        user_id: userId, name: d.device_name ?? 'Устройство', server_id: serverId, protocol: proto,
        is_active: d.is_active ?? 1, last_seen_at: d.last_handshake ?? null, traffic_gb: (rb + sb) / 1e9,
        created_at: d.created_at ?? nowIso(), revoked_at: d.revoked_at ?? null,
        uuid: d.uuid ?? null, public_key: d.public_key ?? null, private_key_enc: privEnc, preshared_key_enc: pskEnc,
        client_ip: d.client_ip ?? null, link: d.link_text ?? null, conf: d.config_text ?? null,
        received_bytes: rb, sent_bytes: sb, monitoring_available: monitoring, legacy_id: d.id,
      };

      if (existing) {
        db.prepare(
          `UPDATE devices SET user_id=@user_id,name=@name,server_id=@server_id,protocol=@protocol,is_active=@is_active,
             last_seen_at=@last_seen_at,traffic_gb=@traffic_gb,revoked_at=@revoked_at,uuid=@uuid,public_key=@public_key,
             private_key_enc=@private_key_enc,preshared_key_enc=@preshared_key_enc,client_ip=@client_ip,link=@link,conf=@conf,
             received_bytes=@received_bytes,sent_bytes=@sent_bytes,monitoring_available=@monitoring_available,
             source='imported',management_level='managed',legacy_id=@legacy_id WHERE id=@id`,
        ).run({ ...fields, id: existing.id });
        result.devicesUpdated++;
      } else {
        db.prepare(
          `INSERT INTO devices(id,user_id,name,server_id,protocol,is_active,last_seen_at,traffic_gb,created_at,revoked_at,
             os_hint,source,management_level,monitoring_available,uuid,public_key,private_key_enc,preshared_key_enc,
             client_ip,link,conf,received_bytes,sent_bytes,legacy_id)
           VALUES(@id,@user_id,@name,@server_id,@protocol,@is_active,@last_seen_at,@traffic_gb,@created_at,@revoked_at,
             NULL,'imported','managed',@monitoring_available,@uuid,@public_key,@private_key_enc,@preshared_key_enc,
             @client_ip,@link,@conf,@received_bytes,@sent_bytes,@legacy_id)`,
        ).run({ ...fields, id: newId('d') });
        result.devicesInserted++;
      }
    }
  });
  tx();
  old.close();
  return result;
}

// CLI
const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('import/legacy.ts')
  || (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('import/legacy.js'));
if (isMain) {
  const fromIdx = process.argv.indexOf('--from');
  const from = fromIdx >= 0 ? process.argv[fromIdx + 1] : undefined;
  if (!from) {
    console.error('Использование: import:legacy -- --from <путь к старой database.sqlite>');
    process.exit(1);
  }
  const r = importLegacy(from);
  console.log('[import:legacy] результат:', JSON.stringify(r, null, 2));
}
