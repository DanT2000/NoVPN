// Постоянное хранилище сессий в той же SQLite-базе. Без него express-session
// использует MemoryStore: сессии теряются при каждом рестарте/редеплое (а панель
// перезапускается при смене пароля и восстановлении бэкапа), плюс утечка памяти.
import session from 'express-session';
import type { SessionData } from 'express-session';
import { db } from '../db.js';

db.exec('CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expire INTEGER NOT NULL)');

const DAY = 24 * 3600 * 1000;
const expireOf = (sess: SessionData): number =>
  sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + DAY;

export class SqliteSessionStore extends session.Store {
  constructor() {
    super();
    // Разовая уборка протухших сессий на старте.
    try {
      db.prepare('DELETE FROM sessions WHERE expire < ?').run(Date.now());
    } catch {
      /* игнор */
    }
  }

  get(sid: string, cb: (err: unknown, session?: SessionData | null) => void): void {
    try {
      const row = db.prepare('SELECT sess, expire FROM sessions WHERE sid = ?').get(sid) as
        | { sess: string; expire: number }
        | undefined;
      if (!row) return cb(null, null);
      if (row.expire < Date.now()) {
        db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
        return cb(null, null);
      }
      cb(null, JSON.parse(row.sess) as SessionData);
    } catch (e) {
      cb(e);
    }
  }

  set(sid: string, sess: SessionData, cb?: (err?: unknown) => void): void {
    try {
      db.prepare(
        'INSERT INTO sessions(sid,sess,expire) VALUES(?,?,?) ON CONFLICT(sid) DO UPDATE SET sess=excluded.sess, expire=excluded.expire',
      ).run(sid, JSON.stringify(sess), expireOf(sess));
      cb?.();
    } catch (e) {
      cb?.(e);
    }
  }

  destroy(sid: string, cb?: (err?: unknown) => void): void {
    try {
      db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      cb?.();
    } catch (e) {
      cb?.(e);
    }
  }

  override touch(sid: string, sess: SessionData, cb?: (err?: unknown) => void): void {
    try {
      db.prepare('UPDATE sessions SET expire = ? WHERE sid = ?').run(expireOf(sess), sid);
      cb?.();
    } catch (e) {
      cb?.(e);
    }
  }
}
