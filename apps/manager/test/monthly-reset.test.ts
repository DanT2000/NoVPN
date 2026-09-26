// Месячный сброс квоты (reset_policy='monthly'): базовая линия обнуляет расход текущего
// периода, дальше расход считается ОТ неё, и повторный сброс в том же месяце — no-op.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = path.join(os.tmpdir(), `novpn-mreset-${process.pid}-${Math.floor(process.hrtime()[1])}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.DATABASE_PATH = path.join(tmp, 'database.sqlite');
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.SESSION_SECRET = 'test';

const repo = await import('../src/repo.js');
const { db } = await import('../src/db.js');

let seq = 700000;
const mkMonthlyUser = () =>
  repo.insertUser({
    name: `M${seq}`,
    comment: '',
    category: 'Общие',
    tags: [],
    code: String(seq++),
    deviceLimit: null,
    expiresAt: null,
    trafficLimitGb: 100,
    resetPolicy: 'monthly',
    allowedServers: [],
    allowedProtocols: ['xray'],
    allowedProxies: [],
    codeLoginEnabled: false,
  } as any);

const usedGb = (id: string) => repo.getUser(id)!.trafficUsedGb ?? 0;

test('месячный сброс: baseline обнуляет расход периода, идемпотентно', () => {
  const u = mkMonthlyUser();
  // Накопленный расход (через retired — проще, чем вставлять устройства).
  db.prepare('UPDATE users SET retired_traffic_gb = 50 WHERE id = ?').run(u.id);
  repo.recomputeUserUsage(u.id);
  assert.ok(Math.abs(usedGb(u.id) - 50) < 0.01, 'до сброса виден весь накопленный (50)');

  // Симулируем прошлый период → сброс должен сработать.
  db.prepare("UPDATE users SET usage_period = '2000-01' WHERE id = ?").run(u.id);
  assert.ok(repo.resetMonthlyQuotas() >= 1, 'сброс затронул хотя бы одного');
  assert.ok(usedGb(u.id) < 0.01, 'после сброса расход текущего периода ~0');

  // Ещё расход внутри периода: считается ОТ базовой линии (70 − 50 = 20).
  db.prepare('UPDATE users SET retired_traffic_gb = 70 WHERE id = ?').run(u.id);
  repo.recomputeUserUsage(u.id);
  assert.ok(Math.abs(usedGb(u.id) - 20) < 0.01, 'период считает 70−50=20');

  // Повторный сброс в ТОМ ЖЕ месяце — no-op (период уже помечен).
  const before = usedGb(u.id);
  repo.resetMonthlyQuotas();
  assert.equal(usedGb(u.id), before, 'в том же периоде повторно не сбрасывает');
});

test('never-политика: baseline не применяется (виден весь накопленный)', () => {
  const u = repo.insertUser({
    name: `N${seq}`, comment: '', category: 'Общие', tags: [], code: String(seq++),
    deviceLimit: null, expiresAt: null, trafficLimitGb: 100, resetPolicy: 'never',
    allowedServers: [], allowedProtocols: ['xray'], allowedProxies: [], codeLoginEnabled: false,
  } as any);
  db.prepare('UPDATE users SET retired_traffic_gb = 33 WHERE id = ?').run(u.id);
  repo.recomputeUserUsage(u.id);
  assert.ok(Math.abs(usedGb(u.id) - 33) < 0.01);
  // Сброс не трогает never-политику.
  repo.resetMonthlyQuotas();
  repo.recomputeUserUsage(u.id);
  assert.ok(Math.abs(usedGb(u.id) - 33) < 0.01, 'never — весь накопленный, сброс не влияет');
});
