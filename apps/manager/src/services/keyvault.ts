// Хранилище серверных ключей по ДОМЕНУ (шифрование в БД).
// Логика восстановления по домену: если пересоздаёшь сервер на том же домене,
// панель подставляет сохранённые серверные ключи → старые конфиги живут.
// Приватные ключи наружу не отдаются (только в install-скрипт при провижининге).

import { db } from '../db.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';
import { nowIso } from '../repo.js';

export interface ServerKeys {
  awgServerPrivKey?: string;
  awgServerPubKey?: string;
  xrayRealityPrivKey?: string;
  xrayRealityPubKey?: string;
  xrayShortId?: string;
  xraySni?: string;
}

/** Нормализуем домен как ключ (без протокола/порта, в нижний регистр). */
export function domainKey(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/[:/].*$/, '');
}

export function saveServerKeys(host: string, k: ServerKeys): void {
  const domain = domainKey(host);
  db.prepare(
    `INSERT INTO server_keys(domain, awg_server_privkey_enc, awg_server_pubkey,
       xray_reality_privkey_enc, xray_reality_pubkey, xray_short_id, xray_sni, updated_at)
     VALUES(@domain,@awgPriv,@awgPub,@xrayPriv,@xrayPub,@sid,@sni,@now)
     ON CONFLICT(domain) DO UPDATE SET
       awg_server_privkey_enc=COALESCE(excluded.awg_server_privkey_enc, server_keys.awg_server_privkey_enc),
       awg_server_pubkey=COALESCE(excluded.awg_server_pubkey, server_keys.awg_server_pubkey),
       xray_reality_privkey_enc=COALESCE(excluded.xray_reality_privkey_enc, server_keys.xray_reality_privkey_enc),
       xray_reality_pubkey=COALESCE(excluded.xray_reality_pubkey, server_keys.xray_reality_pubkey),
       xray_short_id=COALESCE(excluded.xray_short_id, server_keys.xray_short_id),
       xray_sni=COALESCE(excluded.xray_sni, server_keys.xray_sni),
       updated_at=excluded.updated_at`,
  ).run({
    domain,
    awgPriv: k.awgServerPrivKey ? encryptSecret(k.awgServerPrivKey) : null,
    awgPub: k.awgServerPubKey ?? null,
    xrayPriv: k.xrayRealityPrivKey ? encryptSecret(k.xrayRealityPrivKey) : null,
    xrayPub: k.xrayRealityPubKey ?? null,
    sid: k.xrayShortId ?? null,
    sni: k.xraySni ?? null,
    now: nowIso(),
  });
}

/** Есть ли сохранённые ключи для домена (для показа «восстановим по домену»). */
export function hasServerKeys(host: string): boolean {
  const r = db.prepare('SELECT domain FROM server_keys WHERE domain = ?').get(domainKey(host));
  return !!r;
}

/** Расшифрованные ключи для передачи в install-скрипт при восстановлении. */
export function getServerKeys(host: string): ServerKeys | null {
  const r = db.prepare('SELECT * FROM server_keys WHERE domain = ?').get(domainKey(host)) as any;
  if (!r) return null;
  return {
    awgServerPrivKey: r.awg_server_privkey_enc ? decryptSecret(r.awg_server_privkey_enc) : undefined,
    awgServerPubKey: r.awg_server_pubkey ?? undefined,
    xrayRealityPrivKey: r.xray_reality_privkey_enc ? decryptSecret(r.xray_reality_privkey_enc) : undefined,
    xrayRealityPubKey: r.xray_reality_pubkey ?? undefined,
    xrayShortId: r.xray_short_id ?? undefined,
    xraySni: r.xray_sni ?? undefined,
  };
}
