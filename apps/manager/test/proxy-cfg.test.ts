// Регресс на инцидент: 3proxy падал в крэш-луп, если у сервера >1 прокси-логина,
// потому что строка allow клеила логины ПРОБЕЛОМ (3proxy читал 2-й логин как IP).
// Гоняем РЕАЛЬНЫЙ python-пересборщик конфига (PROXY_REBUILD_PY) на образцах.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

process.env.DATABASE_PATH = path.join(os.tmpdir(), `novpn-pxcfg-${process.pid}`, 'db.sqlite');
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.SESSION_SECRET = 'test';
fs.mkdirSync(path.dirname(process.env.DATABASE_PATH), { recursive: true });

const { PROXY_REBUILD_PY } = await import('../src/services/sshServer.js');

function pythonCmd(): string | null {
  for (const c of ['python3', 'python']) {
    try {
      execFileSync(c, ['--version'], { stdio: 'ignore' });
      return c;
    } catch {
      /* нет такого */
    }
  }
  return null;
}
const PY = pythonCmd();

function rebuild(cfg: string, mode: string, login: string, pass: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxcfg-'));
  const cfgPath = path.join(dir, '3proxy.cfg');
  const pyPath = path.join(dir, 'rebuild.py');
  fs.writeFileSync(cfgPath, cfg);
  fs.writeFileSync(pyPath, PROXY_REBUILD_PY);
  execFileSync(PY!, [pyPath, mode, login, pass, cfgPath]);
  return fs.readFileSync(cfgPath, 'utf8');
}

const BASE =
  'nscache 65536\nusers novpn:CL:pw0\nauth strong\nallow novpn\n' +
  'proxy -n -a -p8080 -i0.0.0.0 -e0.0.0.0\nsocks -p1080 -i0.0.0.0 -e0.0.0.0\n';

test('allow с несколькими логинами — через ЗАПЯТУЮ (иначе 3proxy падает)', { skip: !PY }, () => {
  const out = rebuild(BASE, 'add', 'userIqtic', 'pw1');
  const lines = out.split(/\r?\n/);
  assert.equal(lines.find((l) => l.startsWith('allow ')), 'allow novpn,userIqtic');
  const users = lines.find((l) => l.startsWith('users '))!;
  assert.ok(users.includes('novpn:CL:pw0') && users.includes('userIqtic:CL:pw1'), 'оба логина в users');
  assert.ok(out.includes('proxy -n -a -p8080') && out.includes('socks -p1080'), 'сервисы сохранены');
});

test('remove убирает логин, allow снова валиден', { skip: !PY }, () => {
  const two = rebuild(BASE, 'add', 'alice', 'p1'); // novpn,alice
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxcfg2-'));
  const cp = path.join(dir, 'c.cfg');
  const pp = path.join(dir, 'r.py');
  fs.writeFileSync(cp, two);
  fs.writeFileSync(pp, PROXY_REBUILD_PY);
  execFileSync(PY!, [pp, 'remove', 'alice', '', cp]);
  const res = fs.readFileSync(cp, 'utf8');
  assert.equal(res.split(/\r?\n/).find((l) => l.startsWith('allow ')), 'allow novpn');
});

test('три логина — все через запятую', { skip: !PY }, () => {
  const two = rebuild(BASE, 'add', 'a', 'p1');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxcfg3-'));
  const cp = path.join(dir, 'c.cfg');
  const pp = path.join(dir, 'r.py');
  fs.writeFileSync(cp, two);
  fs.writeFileSync(pp, PROXY_REBUILD_PY);
  execFileSync(PY!, [pp, 'add', 'b', 'p2', cp]);
  const res = fs.readFileSync(cp, 'utf8');
  const allow = res.split(/\r?\n/).find((l) => l.startsWith('allow '))!;
  assert.equal(allow, 'allow novpn,a,b');
  assert.ok(!/allow \S+ \S/.test(allow), 'в allow нет пробелов между логинами');
});
