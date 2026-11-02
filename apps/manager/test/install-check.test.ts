// Самопроверка установки сервера (03.11.2026): установка Франции встала наполовину — Xray
// есть, AmneziaWG нет, — а сервер в админке выглядел исправным. Скрипт гоняем НАСТОЯЩИМ
// bash с заглушками docker/ss/ip, изображающими состояние сервера.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const tmp = path.join(os.tmpdir(), `novpn-instchk-${process.pid}-${Math.floor(process.hrtime()[1])}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.DATABASE_PATH = path.join(tmp, 'database.sqlite');
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.SESSION_SECRET = 'test-secret';

const { installCheckScript, parseInstallCheck, formatInstallCheck } = await import('../src/services/sshServer.js');
const repo = await import('../src/repo.js');

const noBash = spawnSync('bash', ['--version']).error ? 'bash недоступен' : false;

/** Прогнать проверку на «сервере»: xrayUp, tcp — слушающие TCP-порты, udp, awg0 — есть ли интерфейс. */
function run(script: string, st: { xrayUp: boolean; tcp: number[]; udp: number[]; awg0: boolean }): string {
  // Заглушки — функциями bash (перекрывают команды): одинаково в Linux и Git Bash на Windows.
  const lines = (fmt: (p: number) => string, list: number[]) => list.map((p) => `echo "${fmt(p)}"`).join('; ') || 'true';
  const stub = [
    `docker() { echo "${st.xrayUp ? 'Up 3 minutes' : 'Exited (1) 2 minutes ago'}"; }`,
    `ss() { case "$1" in -ltn) ${lines((p) => `LISTEN 0 4096 0.0.0.0:${p} 0.0.0.0:*`, st.tcp)};; -uln) ${lines((p) => `UNCONN 0 0 0.0.0.0:${p} 0.0.0.0:*`, st.udp)};; esac; }`,
    `ip() { return ${st.awg0 ? 0 : 1}; }`,
  ].join('\n');
  return spawnSync('bash', [], { input: `${stub}\n${script}\n`, encoding: 'utf8' }).stdout;
}

const want = { xray: true, awg: true, http: true, socks: true };
const ports = { xray: 443, awg: 47945, http: 8080, socks: 1080 };

test('всё работает — все галочки', { skip: noBash }, () => {
  const out = run(installCheckScript(want, ports), { xrayUp: true, tcp: [443, 8080, 1080], udp: [47945], awg0: true });
  const c = parseInstallCheck(out);
  assert.deepEqual(c.map((x) => [x.key, x.ok]), [['xray', true], ['awg', true], ['http', true], ['socks', true]]);
  assert.equal(formatInstallCheck(c), 'Xray ✓, AmneziaWG ✓, HTTP-прокси ✓, SOCKS5-прокси ✓');
});

test('Франция 02.11: Xray встал, AmneziaWG нет — видно, что и почему', { skip: noBash }, () => {
  const c = parseInstallCheck(run(installCheckScript(want, ports), { xrayUp: true, tcp: [443], udp: [], awg0: false }));
  const awg = c.find((x) => x.key === 'awg')!;
  assert.equal(awg.ok, false);
  assert.match(awg.detail, /awg0/);
  assert.match(formatInstallCheck(c), /AmneziaWG ✗ \(нет интерфейса awg0\)/);
  assert.equal(c.find((x) => x.key === 'http')!.ok, false, 'прокси тоже не встали');
});

test('контейнер Xray упал / порт не тот — разные причины', { skip: noBash }, () => {
  let c = parseInstallCheck(run(installCheckScript({ xray: true }, { xray: 443 }), { xrayUp: false, tcp: [443], udp: [], awg0: true }));
  assert.match(c[0]!.detail, /контейнер не запущен/);
  c = parseInstallCheck(run(installCheckScript({ xray: true }, { xray: 443 }), { xrayUp: true, tcp: [47265], udp: [], awg0: true }));
  assert.match(c[0]!.detail, /не слушает TCP 443/, 'Xray на чужом порту — не то, что выдано людям');
});

test('интерфейс есть, но UDP-порт не слушается', { skip: noBash }, () => {
  const c = parseInstallCheck(run(installCheckScript({ awg: true }, { awg: 47945 }), { xrayUp: true, tcp: [], udp: [51820], awg0: true }));
  assert.equal(c[0]!.ok, false);
  assert.match(c[0]!.detail, /UDP 47945/);
});

test('проверяем только то, что ставили', () => {
  assert.equal(installCheckScript({}, {}), '');
  assert.doesNotMatch(installCheckScript({ xray: true }, { xray: 443 }), /awg0|CHK http/);
});

test('итог проверки хранится у сервера и приходит в админку', () => {
  const s = repo.insertServer({ name: 'FR', country: 'FR', host: '2.vpn.example.com', protocols: ['xray', 'amneziawg'], endpointOk: true });
  assert.equal(repo.getServer(s.id)!.installCheck, null);
  repo.setInstallCheck(s.id, { at: '2026-11-03T00:00:00Z', ok: false, summary: 'Xray ✓, AmneziaWG ✗ (нет интерфейса awg0)', error: null, checks: [] });
  const got = repo.getServer(s.id)!.installCheck!;
  assert.equal(got.ok, false);
  assert.match(got.summary, /AmneziaWG ✗/);
  assert.ok(repo.listServers().find((x) => x.id === s.id)!.installCheck, 'и в списке серверов');
  repo.setInstallCheck(s.id, null);
  assert.equal(repo.getServer(s.id)!.installCheck, null);
});
