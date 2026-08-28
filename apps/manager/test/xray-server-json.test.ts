// Регресс на инцидент 28.08.2026: панель ставит teddysun/xray без тега (latest = Xray ≥ 26.7.11),
// а такой Xray без minClientVer молча отвергает mihomo (движок NoVPN Desktop представляется
// REALITY-клиентом 1.8.2) — телефоны работают, десктоп «REALITY authentication failed».
// Гоняем РЕАЛЬНЫЙ python-генератор server.json (XRAY_SERVER_JSON_PY) и проверяем контракт.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

process.env.DATABASE_PATH = path.join(os.tmpdir(), `novpn-xrayjson-${process.pid}`, 'db.sqlite');
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.SESSION_SECRET = 'test';
fs.mkdirSync(path.dirname(process.env.DATABASE_PATH), { recursive: true });

const { XRAY_SERVER_JSON_PY } = await import('../src/services/sshServer.js');

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

function generate(sni: string, priv: string, sid: string): any {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xrayjson-'));
  const pyPath = path.join(dir, 'gen.py');
  fs.writeFileSync(pyPath, XRAY_SERVER_JSON_PY);
  return JSON.parse(execFileSync(PY!, [pyPath, sni, priv, sid], { encoding: 'utf8' }));
}

test('server.json: REALITY с minClientVer=1.8.2 (иначе Xray ≥ 26.7.11 отвергает mihomo)', { skip: !PY }, () => {
  const cfg = generate('cdn.dodostatic.net', 'PRIVKEY', '5b82014c36d33322');
  const inb = cfg.inbounds[0];
  assert.equal(inb.protocol, 'vless');
  assert.equal(inb.port, 443);
  assert.equal(inb.settings.decryption, 'none');
  assert.deepEqual(inb.settings.clients, []);
  const rs = inb.streamSettings.realitySettings;
  assert.equal(rs.minClientVer, '1.8.2');
  assert.equal(rs.show, false);
  assert.equal(rs.dest, 'cdn.dodostatic.net:443');
  assert.deepEqual(rs.serverNames, ['cdn.dodostatic.net']);
  assert.deepEqual(rs.shortIds, ['5b82014c36d33322']);
  assert.equal(rs.privateKey, 'PRIVKEY');
});

test('server.json: api-inbound статистики и sniffing на месте', { skip: !PY }, () => {
  const cfg = generate('a.example', 'k', 'ab');
  assert.ok(cfg.inbounds[0].sniffing.enabled);
  const api = cfg.inbounds.find((i: any) => i.tag === 'api');
  assert.equal(api.listen, '127.0.0.1');
  assert.equal(api.port, 10085);
  assert.deepEqual(cfg.api.services, ['StatsService']);
  assert.ok(cfg.policy.levels['0'].statsUserUplink && cfg.policy.levels['0'].statsUserDownlink);
});
