// Экспорт/импорт базы под паролем администратора.
//
// Смысл: у прода нет второй копии на случай гибели хоста с панелью (том — на том
// же диске). Кнопка «Скачать бэкап» даёт админу самодостаточный файл: развернул
// новую панель с ЛЮБЫМ ENCRYPTION_KEY, залил бэкап, ввёл пароль — всё встало.
//
// Файл шифруется паролем АДМИНА, а не ENCRYPTION_KEY сервера: иначе для
// восстановления понадобились бы и файл, и ключ — два секрета вместо одного,
// и оба на умершем хосте. Внутри — сырой снимок sqlite (в нём serverKeys уже
// зашифрованы своим ENCRYPTION_KEY, но их назначение — работать на том же
// ENCRYPTION_KEY; поэтому при переносе на новый ключ восстанавливается всё, что
// не зашифровано им, а серверные ключи переставляются заново — см. памятку).

import crypto from 'node:crypto';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { config } from '../config.js';
import { db } from '../db.js';

const MAGIC = 'NOVPNBAK';
const VERSION = 1;

/** Снять консистентный снимок базы во временный файл и вернуть его содержимое. */
function snapshot(): Buffer {
  const tmp = `${config.databasePath}.backup-${crypto.randomBytes(6).toString('hex')}`;
  try {
    // VACUUM INTO даёт согласованную копию без блокировки и без WAL-хвостов.
    db.prepare('VACUUM INTO ?').run(tmp);
    return fs.readFileSync(tmp);
  } finally {
    for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) {
      try {
        fs.rmSync(f, { force: true });
      } catch {
        /* уже нет */
      }
    }
  }
}

/**
 * Зашифрованный бэкап. Формат:
 *   MAGIC(8) | ver(1) | salt(16) | iv(12) | authTag(16) | ciphertext
 * AES-256-GCM, ключ = scrypt(пароль, salt).
 */
export function createBackup(password: string): Buffer {
  if (!password || password.length < 8) throw new Error('Пароль бэкапа — минимум 8 символов.');
  const plain = snapshot();
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from(MAGIC, 'ascii'), Buffer.from([VERSION]), salt, iv, tag, ct]);
}

/** Расшифровать бэкап и вернуть сырые байты sqlite. Бросает при неверном пароле. */
export function decryptBackup(buf: Buffer, password: string): Buffer {
  if (buf.length < 8 + 1 + 16 + 12 + 16) throw new Error('Файл повреждён или это не бэкап.');
  if (buf.subarray(0, 8).toString('ascii') !== MAGIC) throw new Error('Это не файл бэкапа NoVPN.');
  const ver = buf[8];
  if (ver !== VERSION) throw new Error(`Неизвестная версия бэкапа: ${ver}.`);
  const salt = buf.subarray(9, 25);
  const iv = buf.subarray(25, 37);
  const tag = buf.subarray(37, 53);
  const ct = buf.subarray(53);
  const key = crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new Error('Неверный пароль или файл повреждён.');
  }
}

/**
 * Восстановить базу из расшифрованного снимка. Проверяет, что это валидный
 * sqlite нашей схемы, затем подменяет файл базы и просит перезапустить процесс
 * (better-sqlite3 держит старый файл открытым — переоткрыть в рантайме нельзя).
 */
export function restoreBackup(sqliteBytes: Buffer): { users: number } {
  const tmp = `${config.databasePath}.restore-${crypto.randomBytes(6).toString('hex')}`;
  fs.writeFileSync(tmp, sqliteBytes);
  let users = 0;
  try {
    const check = new Database(tmp, { readonly: true });
    try {
      const row = check.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
      users = row.n;
      // Убедимся, что ключевые таблицы на месте — иначе это не наша база.
      check.prepare('SELECT 1 FROM servers LIMIT 1').all();
      check.prepare('SELECT 1 FROM server_keys LIMIT 1').all();
    } finally {
      check.close();
    }
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`Файл не похож на базу NoVPN: ${e instanceof Error ? e.message : 'ошибка чтения'}.`);
  }

  // Кладём рядом как «ожидающий» — подхватится при следующем старте.
  // Прямая подмена открытого файла на Windows/POSIX ненадёжна, поэтому
  // переключение делает загрузчик БД при рестарте.
  const pending = `${config.databasePath}.pending-restore`;
  fs.renameSync(tmp, pending);
  return { users };
}

/** Есть ли ожидающий восстановления файл — вызывается загрузчиком до открытия БД. */
export function pendingRestorePath(): string {
  return `${config.databasePath}.pending-restore`;
}
