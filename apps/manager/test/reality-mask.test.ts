// Смена маски Reality с переходным периодом (03.11.2026, после блокировки Риги).
// Испытано на настоящем сервере: при dest нового сайта клиент со старой маской получал
// «tls: handshake failure» — поэтому на время перехода dest ведёт на локальный «развод по
// имени». Здесь гоняем НАСТОЯЩИЙ python (XRAY_MASK_PY) на шаблоне server.json установки.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const tmp = path.join(os.tmpdir(), `novpn-mask-${process.pid}-${Math.floor(process.hrtime()[1])}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.DATABASE_PATH = path.join(tmp, 'database.sqlite');
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.SESSION_SECRET = 'test-secret';

const { XRAY_SERVER_JSON_PY, XRAY_MASK_PY, MASK_ROUTER_PORT, isValidMask } = await import('../src/services/sshServer.js');
const repo = await import('../src/repo.js');

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

/** server.json как после установки + один клиент (как после выпуска). */
function installed(sni: string): string {
  const dir = fs.mkdtempSync(path.join(tmp, 'x-'));
  const gen = path.join(dir, 'gen.py');
  fs.writeFileSync(gen, XRAY_SERVER_JSON_PY);
  const cfg = JSON.parse(execFileSync(PY!, [gen, sni, 'PRIV', 'abcd'], { encoding: 'utf8' }));
  cfg.inbounds[0].settings.clients.push({ id: 'u-1', flow: 'xtls-rprx-vision', email: 'Телефон' });
  const p = path.join(dir, 'server.json');
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  return p;
}

/** Применить маску как на сервере: WRITTEN → подменить файл. */
function applyMask(p: string, sni: string, legacy: string[]): string {
  const script = path.join(path.dirname(p), 'mask.py');
  fs.writeFileSync(script, XRAY_MASK_PY);
  const out = execFileSync(PY!, [script, p, sni, legacy.join(',')], { encoding: 'utf8' }).trim();
  if (out === 'WRITTEN') fs.renameSync(p + '.tmp', p);
  return out;
}
const read = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'));

test('переходный период: принимаются обе маски, каждая ведёт на свой настоящий сайт', { skip: !PY }, () => {
  const p = installed('cdn.dodostatic.net');
  assert.equal(applyMask(p, 'www.lenovo.com', ['cdn.dodostatic.net']), 'WRITTEN');
  const c = read(p);
  const vless = c.inbounds[0];
  assert.equal(vless.tag, 'vless-reality', 'vless остаётся первым: на inbounds[0] опираются выпуск/отзыв/ресинк');
  assert.deepEqual(vless.settings.clients.map((x: any) => x.id), ['u-1'], 'клиенты не тронуты');
  const rs = vless.streamSettings.realitySettings;
  assert.deepEqual(rs.serverNames, ['www.lenovo.com', 'cdn.dodostatic.net']);
  assert.equal(rs.dest, `127.0.0.1:${MASK_ROUTER_PORT}`);
  assert.equal(rs.privateKey, 'PRIV', 'ключи не меняются — выданные конфиги живы');
  assert.deepEqual(rs.shortIds, ['abcd']);
  assert.equal(rs.minClientVer, '1.8.2');
  const router = c.inbounds.find((i: any) => i.tag === 'mask-router');
  assert.equal(router.listen, '127.0.0.1', 'развод по имени только внутри сервера');
  assert.equal(router.port, MASK_ROUTER_PORT);
  assert.equal(router.protocol, 'dokodemo-door');
  assert.deepEqual(router.sniffing.destOverride, ['tls']);
  assert.equal(c.outbounds[0].tag, 'direct', 'выход по умолчанию прежний');
  assert.ok(c.outbounds.some((o: any) => o.tag === 'mask-direct' && o.protocol === 'freedom'));
  assert.ok(c.outbounds.some((o: any) => o.tag === 'mask-block' && o.protocol === 'blackhole'));
  const [allow, deny] = c.routing.rules;
  assert.deepEqual(allow.domain, ['full:www.lenovo.com', 'full:cdn.dodostatic.net']);
  assert.equal(allow.outboundTag, 'mask-direct');
  assert.equal(deny.outboundTag, 'mask-block', 'чужие имена — в blackhole, не открытый SNI-прокси');
  assert.ok(c.routing.rules.some((r: any) => r.outboundTag === 'api'), 'правило статистики сохранено');
});

test('повторное применение того же — без изменений (без рестарта Xray)', { skip: !PY }, () => {
  const p = installed('cdn.dodostatic.net');
  applyMask(p, 'www.lenovo.com', ['cdn.dodostatic.net']);
  assert.equal(applyMask(p, 'www.lenovo.com', ['cdn.dodostatic.net']), 'SAME');
  assert.equal(c_inbounds(p), 3, 'mask-router не дублируется');
});
const c_inbounds = (p: string) => read(p).inbounds.length;

test('отключение прежней маски возвращает обычный вид, без следов перехода', { skip: !PY }, () => {
  const p = installed('cdn.dodostatic.net');
  const original = read(p);
  applyMask(p, 'www.lenovo.com', ['cdn.dodostatic.net']);
  assert.equal(applyMask(p, 'www.lenovo.com', []), 'WRITTEN');
  const c = read(p);
  const rs = c.inbounds[0].streamSettings.realitySettings;
  assert.deepEqual(rs.serverNames, ['www.lenovo.com']);
  assert.equal(rs.dest, 'www.lenovo.com:443');
  assert.ok(!c.inbounds.some((i: any) => i.tag === 'mask-router'));
  assert.ok(!c.outbounds.some((o: any) => String(o.tag).startsWith('mask-')));
  assert.deepEqual(c.routing.rules, original.routing.rules);
  assert.deepEqual(c.outbounds, original.outbounds);
});

test('смена без переходного периода (новый сервер без людей)', { skip: !PY }, () => {
  const p = installed('cdn.dodostatic.net');
  assert.equal(applyMask(p, 'www.asus.com', []), 'WRITTEN');
  const rs = read(p).inbounds[0].streamSettings.realitySettings;
  assert.deepEqual(rs.serverNames, ['www.asus.com']);
  assert.equal(rs.dest, 'www.asus.com:443');
});

test('основная маска не дублируется среди прежних', { skip: !PY }, () => {
  const p = installed('cdn.dodostatic.net');
  applyMask(p, 'www.asus.com', ['www.asus.com', 'cdn.dodostatic.net', 'cdn.dodostatic.net']);
  assert.deepEqual(read(p).inbounds[0].streamSettings.realitySettings.serverNames, ['www.asus.com', 'cdn.dodostatic.net']);
});

test('имя маски: только домен (подставляется в shell на сервере)', () => {
  assert.ok(isValidMask('www.asus.com'));
  assert.ok(isValidMask('cdn.dodostatic.net'));
  for (const bad of ['', 'asus', "www.asus.com'; rm -rf /", 'www.asus.com:443', '$(id).com', 'WWW.ASUS.COM', '-a.com']) {
    assert.ok(!isValidMask(bad), bad);
  }
});

test('новая маска попадает в уже выданные ссылки только этого сервера', () => {
  const a = repo.insertServer({ name: 'FIN', country: 'FI', host: '1.vpn.example.com', protocols: ['xray'], endpointOk: true });
  const b = repo.insertServer({ name: 'FR', country: 'FR', host: '2.vpn.example.com', protocols: ['xray'], endpointOk: true });
  const user = repo.insertUser({
    name: 'Тест', comment: '', category: null, tags: [], code: 'mask1',
    deviceLimit: 3, expiresAt: null, trafficLimitGb: null, resetPolicy: 'never',
    allowedServers: [a.id, b.id], allowedProtocols: ['xray'],
  });
  const link = (h: string, id: string) =>
    `vless://${id}@${h}:443?type=tcp&security=reality&pbk=P&fp=edge&sni=cdn.dodostatic.net&sid=1&spx=%2F&flow=xtls-rprx-vision&encryption=none#NoVPN`;
  const da = repo.insertDevice({ userId: user.id, name: 'a', serverId: a.id, protocol: 'xray', uuid: 'ua', publicKey: 'k', link: link(a.host, 'ua') });
  const db2 = repo.insertDevice({ userId: user.id, name: 'b', serverId: b.id, protocol: 'xray', uuid: 'ub', publicKey: 'k', link: link(b.host, 'ub') });
  assert.equal(repo.retargetXrayLinksSni(a.id, 'www.lenovo.com'), 1);
  const after = (id: string) => repo.listDevices().find((d: any) => d.id === id)!.link as string;
  assert.match(after(da.id), /[?&]sni=www\.lenovo\.com&/);
  assert.match(after(da.id), /pbk=P&fp=edge&/, 'остальное в ссылке не тронуто');
  assert.match(after(db2.id), /sni=cdn\.dodostatic\.net/, 'чужой сервер не тронут');
  assert.ok(repo.hasActiveXrayDevices(a.id));
  const empty = repo.insertServer({ name: 'NEW', country: 'FR', host: '3.vpn.example.com', protocols: ['xray'], endpointOk: true });
  assert.ok(!repo.hasActiveXrayDevices(empty.id), 'новый сервер без людей — переходный период не нужен');
  repo.setLegacyMasks(a.host, [{ sni: 'cdn.dodostatic.net', since: '2026-11-03T00:00:00Z' }]);
  assert.deepEqual(repo.getLegacyMasks(a.host).map((m) => m.sni), ['cdn.dodostatic.net']);
  assert.deepEqual(repo.getLegacyMasks(b.host), []);
});
