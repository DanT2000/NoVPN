// Идентичность агента: собственная ключевая пара (ed25519) генерируется на
// сервере при первой установке и НЕ покидает его. Приватный ключ — в dataDir
// с правами 600. Для связи с панелью используется взаимная аутентификация
// (подпись запросов), а не общий бессрочный токен.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

export interface Identity {
  agentId: string | null;
  serverId: string | null;
  publicKeyPem: string;
  privateKeyPem: string;
  enrolledAt: string | null;
}

const file = () => path.join(config.dataDir, 'identity.json');

function generate(): Identity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { agentId: null, serverId: null, publicKeyPem: publicKey, privateKeyPem: privateKey, enrolledAt: null };
}

export function loadIdentity(): Identity {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const f = file();
  if (fs.existsSync(f)) {
    return JSON.parse(fs.readFileSync(f, 'utf8')) as Identity;
  }
  const id = generate();
  saveIdentity(id);
  return id;
}

export function saveIdentity(id: Identity): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(id, null, 2), 'utf8');
  try {
    fs.chmodSync(file(), 0o600);
  } catch {
    /* права могут не поддерживаться (Windows) */
  }
}

/** Подпись тела запроса приватным ключом агента. Панель проверяет публичным. */
export function sign(id: Identity, payload: string): string {
  const key = crypto.createPrivateKey(id.privateKeyPem);
  return crypto.sign(null, Buffer.from(payload), key).toString('base64');
}
