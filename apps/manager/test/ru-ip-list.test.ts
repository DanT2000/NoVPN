// Российские сети для приложений: /routing/ru-ip.txt (services/ruIpList.ts).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server as HttpServer } from 'node:http';

const tmp = path.join(os.tmpdir(), `novpn-ruip-${process.pid}-${Math.floor(process.hrtime()[1])}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.DATABASE_PATH = path.join(tmp, 'database.sqlite');
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.SESSION_SECRET = 'test-secret';

const { normV4, parseRipeRu, refreshRuIpList, getRuIpList } = await import('../src/services/ruIpList.js');
const { seedIfEmpty } = await import('../src/seed.js');
const { createApp } = await import('../src/app.js');
seedIfEmpty();

let server: HttpServer;
let base = '';
before(async () => {
  server = createApp().listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server?.close();
});

const ripe = (nets: string[]) => async () => new Response(JSON.stringify({ data: { resources: { ipv4: nets } } }), { status: 200 });
const many = (n: number) => Array.from({ length: n }, (_, i) => `31.${(i >> 8) & 255}.${i & 255}.0/24`);

test('сеть нормализуется: хвост адреса обнуляется, мусор отбрасывается', () => {
  assert.equal(normV4('185.178.208.184/22'), '185.178.208.0/22');
  assert.equal(normV4('10.0.0.7/24'), '10.0.0.0/24');
  assert.equal(normV4('0.0.0.0/0'), '0.0.0.0/0');
  assert.equal(normV4('1.2.3.4/32'), '1.2.3.4/32');
  for (const bad of ['1.2.3.4', '300.1.1.1/8', '1.2.3.4/33', '2a00::/16', 'x']) assert.equal(normV4(bad), null, bad);
  assert.deepEqual(parseRipeRu({ data: { resources: { ipv4: ['5.3.0.0/16', '5.3.0.1/16', 'мусор', 7] } } }), ['5.3.0.0/16']);
  assert.deepEqual(parseRipeRu(null), []);
});

test('список: пока не скачан — 404; скачан — текст и ETag; недокачанный не затирает прошлый', async () => {
  assert.equal((await fetch(`${base}/routing/ru-ip.txt`)).status, 404);
  assert.equal(await refreshRuIpList(ripe(many(1500)) as typeof fetch), 1500);
  const r = await fetch(`${base}/routing/ru-ip.txt`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') ?? '', /text\/plain/);
  const lines = (await r.text()).trim().split('\n');
  assert.equal(lines.length, 1500);
  assert.equal(lines[0], '31.0.0.0/24');
  const etag = r.headers.get('etag')!;
  assert.equal((await fetch(`${base}/routing/ru-ip.txt`, { headers: { 'if-none-match': etag } })).status, 304);
  assert.equal(await refreshRuIpList(ripe(many(10)) as typeof fetch), null, 'неполный ответ RIPE не берём');
  assert.equal(await refreshRuIpList((async () => { throw new Error('сеть'); }) as typeof fetch), null);
  assert.equal(getRuIpList()?.count, 1500, 'остался прошлый список');
});
