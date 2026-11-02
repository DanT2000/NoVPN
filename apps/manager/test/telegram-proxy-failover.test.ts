// Бот ходит в Telegram через прокси нескольких серверов по очереди (03.11.2026: оповещения
// админу шли через прокси одного сервера и молча пропадали, когда его заблокировали).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = path.join(os.tmpdir(), `novpn-tgproxy-${process.pid}-${Math.floor(process.hrtime()[1])}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.DATABASE_PATH = path.join(tmp, 'database.sqlite');
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.SESSION_SECRET = 'test-secret';

const repo = await import('../src/repo.js');
const { saveServerProxy } = await import('../src/services/keyvault.js');
const tgm = await import('../src/services/telegram.js');

const fin = repo.insertServer({ name: 'Финляндия', country: 'FI', host: '1.vpn.example.com', protocols: ['xray', 'http'], endpointOk: true });
const fr = repo.insertServer({ name: 'Франция', country: 'FR', host: '2.vpn.example.com', protocols: ['xray', 'http'], endpointOk: true });
const bare = repo.insertServer({ name: 'Без прокси', country: 'NL', host: '3.vpn.example.com', protocols: ['xray'], endpointOk: true });
saveServerProxy(fin.host, { user: 'u1', pass: 'p1', httpPort: 8080 });
saveServerProxy(fr.host, { user: 'u2', pass: 'p2', httpPort: 8081 });

function setTg(patch: Record<string, unknown>) {
  repo.saveTelegramRaw({ ...repo.getTelegram(), proxyOn: true, proxySource: 'server', ...patch } as never);
}

test('все отмеченные серверы — по порядку, сервер без прокси пропускается', () => {
  setTg({ proxyServerIds: [fr.id, bare.id, fin.id], proxyServerId: fr.id });
  const urls = tgm.resolveTgProxyUrls();
  assert.equal(urls.length, 2);
  assert.match(urls[0]!, /@2\.vpn\.example\.com:8081$/);
  assert.match(urls[1]!, /@1\.vpn\.example\.com:8080$/);
});

test('прежняя настройка с одним сервером продолжает работать', () => {
  setTg({ proxyServerIds: undefined, proxyServerId: fin.id });
  assert.deepEqual(tgm.tgProxyServerIds(repo.getTelegram()), [fin.id]);
  assert.equal(tgm.resolveTgProxyUrls().length, 1);
});

test('первым пробуем последний сработавший прокси, остальные — следом', () => {
  assert.deepEqual(tgm.orderTgProxies(['a', 'b', 'c'], 'b'), ['b', 'a', 'c']);
  assert.deepEqual(tgm.orderTgProxies(['a', 'b'], null), ['a', 'b']);
  assert.deepEqual(tgm.orderTgProxies(['a', 'b'], 'gone'), ['a', 'b'], 'сработавший сняли с галочки — не цепляемся');
});

test('не отвечает первый прокси — запрос уходит через следующий', async () => {
  setTg({ proxyServerIds: [fin.id, fr.id] });
  const seen: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, opts: { dispatcher?: unknown }) => {
    const n = seen.length;
    seen.push(String(n));
    if (n === 0) throw new TypeError('fetch failed'); // Финляндия заблокирована
    void opts;
    return new Response(JSON.stringify({ ok: true, result: { username: 'novpn_bot' } }));
  }) as never;
  try {
    const me = await tgm.tgApi<{ username: string }>('getMe', {}, '123456:' + 'A'.repeat(35));
    assert.equal(me.username, 'novpn_bot');
    assert.equal(seen.length, 2, 'вторая попытка — через следующий сервер');
    assert.match(tgm.resolveTgProxyUrl()!, /@2\.vpn\.example\.com:8081$/, 'дальше сразу через сработавший');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('все прокси молчат — ошибка, а не зависание', async () => {
  setTg({ proxyServerIds: [fin.id, fr.id] });
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    throw new TypeError('fetch failed');
  }) as never;
  try {
    await assert.rejects(tgm.tgApi('getMe', {}, '123456:' + 'A'.repeat(35)), /fetch failed/);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});
