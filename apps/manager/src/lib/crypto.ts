// Шифрование секретов в БД (AES-256-GCM). Ключ — ENCRYPTION_KEY.
// Шифруем: Telegram-токены, proxy-пароли, приватные ключи, enrollment-секреты.
// Секреты никогда не логируются и не возвращаются через API после сохранения.

import crypto from 'node:crypto';
import { config } from '../config.js';

function keyBytes(): Buffer {
  const raw = config.encryptionKey;
  if (!raw) {
    // В деве допускаем производный ключ, но предупреждаем.
    if (config.isProd) throw new Error('ENCRYPTION_KEY не задан — обязателен в production');
    return crypto.createHash('sha256').update('novpn-dev-fallback-key').digest();
  }
  // Принимаем base64 или hex или сырую строку → нормализуем в 32 байта.
  let buf: Buffer;
  try {
    buf = Buffer.from(raw, 'base64');
    if (buf.length !== 32) buf = Buffer.from(raw, 'hex');
  } catch {
    buf = Buffer.alloc(0);
  }
  if (buf.length !== 32) buf = crypto.createHash('sha256').update(raw).digest();
  return buf;
}

const KEY = keyBytes();

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}

export function decryptSecret(payload: string): string {
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('bad ciphertext');
  const iv = Buffer.from(parts[1]!, 'base64');
  const tag = Buffer.from(parts[2]!, 'base64');
  const data = Buffer.from(parts[3]!, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export function maskTail(secret: string, keep = 4): string {
  if (!secret) return '';
  return `••••${secret.slice(-keep)}`;
}

export function randomToken(bytes = 24): string {
  return crypto.randomBytes(bytes).toString('base64url');
}
