// Российские сервисы мимо сервера (09.11.2026, после блокировки Финляндии): за 4 часа через
// новый сервер прошло ~100 соединений к Яндексу, VK, Max, Сберу с устройств, где туннель
// полный. Сервер не должен выпускать их наружу — тогда российское приложение не увидит его
// адрес. Гоняем НАСТОЯЩИЕ python-правку server.json и bash-скрипт сервера; docker, nft,
// curl, systemctl и ip подменены заглушками, пути сервера — на временный каталог.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';

const tmp = path.join(os.tmpdir(), `novpn-ruguard-${process.pid}-${Math.floor(process.hrtime()[1])}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.DATABASE_PATH = path.join(tmp, 'database.sqlite');
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.SESSION_SECRET = 'test-secret';

const {
  XRAY_SERVER_JSON_PY, XRAY_MASK_PY, XRAY_RUGUARD_PY, RU_LIST_PY, RU_GUARD_DOMAINS,
  ruGuardScript, parseRuGuard, formatRuGuard, ruGuardEligible,
} = await import('../src/services/sshServer.js');

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
const noBash = spawnSync('bash', ['--version']).error ? 'bash недоступен' : false;
const noTools = !PY ? 'python недоступен' : noBash;

let seq = 0;
const dir = () => {
  const d = path.join(tmp, `c${++seq}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const read = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'));

/** server.json как после установки + один клиент. */
function installed(d: string, sni = 'www.lenovo.com'): string {
  const gen = path.join(d, 'gen.py');
  fs.writeFileSync(gen, XRAY_SERVER_JSON_PY);
  const cfg = JSON.parse(execFileSync(PY!, [gen, sni, 'PRIV', 'abcd'], { encoding: 'utf8' }));
  cfg.inbounds[0].settings.clients.push({ id: 'u-1', flow: 'xtls-rprx-vision', email: 'Телефон' });
  const p = path.join(d, 'server.json');
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  return p;
}

/** Правка как на сервере: WRITTEN → подменить файл. */
function runPy(code: string, p: string, ...args: string[]): string {
  const script = path.join(path.dirname(p), `s${++seq}.py`);
  fs.writeFileSync(script, code);
  const out = execFileSync(PY!, [script, p, ...args], { encoding: 'utf8' }).trim();
  if (out === 'WRITTEN') fs.renameSync(p + '.tmp', p);
  return out;
}

test('включение: российские адреса и сервисы — в blackhole, остальное как было', { skip: !PY }, () => {
  const p = installed(dir());
  const before = read(p);
  assert.equal(runPy(XRAY_RUGUARD_PY, p, '1'), 'WRITTEN');
  const c = read(p);
  assert.equal(c.inbounds[0].tag, 'vless-reality', 'vless первым: на inbounds[0] опираются выпуск/отзыв');
  assert.deepEqual(c.inbounds[0].settings.clients, before.inbounds[0].settings.clients, 'клиенты не тронуты');
  assert.deepEqual(c.inbounds[0].streamSettings, before.inbounds[0].streamSettings, 'ключи и маска не тронуты');
  assert.equal(c.outbounds[0].tag, 'direct', 'выход по умолчанию прежний — иначе blackhole съел бы весь трафик');
  assert.deepEqual(c.outbounds.at(-1), { protocol: 'blackhole', tag: 'ru-block' });
  assert.equal(c.routing.domainStrategy, 'IPIfNonMatch', 'имена резолвятся и сверяются с geoip:ru');
  const rules = c.routing.rules;
  assert.deepEqual(rules[0], before.routing.rules[0], 'правило API на месте и первым');
  const byIp = rules.find((r: any) => r.ip);
  assert.deepEqual(byIp, { type: 'field', inboundTag: ['vless-reality'], ip: ['geoip:ru'], outboundTag: 'ru-block' });
  const byName = rules.find((r: any) => r.domain && r.outboundTag === 'ru-block');
  assert.deepEqual(byName.inboundTag, ['vless-reality'], 'режем только клиентский трафик, не служебный');
  for (const d of ['yandex.ru', 'vk.com', 'oneme.ru', 'max.ru', 'rustore.ru', 'sberbank.ru', 'gosuslugi.ru', 'vk-analytics.ru', 'apptracer.ru']) {
    assert.ok(byName.domain.includes(`domain:${d}`), `нет ${d}`);
  }
  assert.equal(byName.domain.length, RU_GUARD_DOMAINS.length);
});

test('повторное включение — SAME (без рестарта Xray), выключение возвращает конфиг установки', { skip: !PY }, () => {
  const p = installed(dir());
  const orig = read(p);
  runPy(XRAY_RUGUARD_PY, p, '1');
  assert.equal(runPy(XRAY_RUGUARD_PY, p, '1'), 'SAME');
  assert.equal(runPy(XRAY_RUGUARD_PY, p, '0'), 'WRITTEN');
  assert.deepEqual(read(p), orig, 'после выключения — ровно прежний конфиг');
  assert.equal(runPy(XRAY_RUGUARD_PY, p, '0'), 'SAME');
});

test('выключение не трогает чужую стратегию маршрутизации', { skip: !PY }, () => {
  const p = installed(dir());
  const c = read(p);
  c.routing.domainStrategy = 'IPIfNonMatch';
  fs.writeFileSync(p, JSON.stringify(c));
  assert.equal(runPy(XRAY_RUGUARD_PY, p, '0'), 'SAME', 'ru-block не было — стратегия не наша');
  assert.equal(read(p).routing.domainStrategy, 'IPIfNonMatch');
});

test('нет выхода по умолчанию — не трогаем (blackhole не должен стать первым)', { skip: !PY }, () => {
  const p = installed(dir());
  const c = read(p);
  c.outbounds = [];
  fs.writeFileSync(p, JSON.stringify(c));
  assert.equal(runPy(XRAY_RUGUARD_PY, p, '1'), 'NO_OUTBOUND');
  assert.ok(!fs.existsSync(p + '.tmp'));
});

test('смена маски с переходным периодом не теряет защиту, защита не ломает маску', { skip: !PY }, () => {
  const p = installed(dir(), 'cdn.dodostatic.net');
  runPy(XRAY_RUGUARD_PY, p, '1');
  assert.equal(runPy(XRAY_MASK_PY, p, 'www.lenovo.com', 'cdn.dodostatic.net'), 'WRITTEN');
  let c = read(p);
  assert.equal(c.routing.rules[0].inboundTag[0], 'mask-router', 'развод по имени — первым');
  assert.ok(c.routing.rules.some((r: any) => r.outboundTag === 'ru-block' && r.ip), 'защита на месте');
  assert.equal(c.outbounds[0].tag, 'direct');
  // И в обратном порядке: включение при уже действующем переходе.
  const q = installed(dir(), 'cdn.dodostatic.net');
  runPy(XRAY_MASK_PY, q, 'www.lenovo.com', 'cdn.dodostatic.net');
  runPy(XRAY_RUGUARD_PY, q, '1');
  c = read(q);
  const [allow, deny] = c.routing.rules;
  assert.equal(allow.outboundTag, 'mask-direct');
  assert.equal(deny.outboundTag, 'mask-block');
  assert.ok(c.outbounds.some((o: any) => o.tag === 'mask-block'));
});

test('список сетей RIPE: только правдоподобный, адреса нормализуются', { skip: !PY }, () => {
  const d = dir();
  const src = path.join(d, 'ru4.json');
  const out = path.join(d, 'ru4.txt');
  const run = () => {
    const s = path.join(d, 'l.py');
    fs.writeFileSync(s, RU_LIST_PY);
    return spawnSync(PY!, [s, src, out], { encoding: 'utf8' });
  };
  const many = Array.from({ length: 1500 }, (_, i) => `10.${(i >> 8) & 255}.${i & 255}.7/24`);
  fs.writeFileSync(src, JSON.stringify({ data: { resources: { ipv4: [...many, '5.6.7.8-5.6.7.9'] } } }));
  run();
  const lines = fs.readFileSync(out + '.new', 'utf8').trim().split('\n');
  assert.equal(lines.length, 1500, 'диапазон без префикса пропущен');
  assert.equal(lines[0], '10.0.0.0/24', 'хвост адреса обнулён — nft не примет 10.0.0.7/24');
  fs.rmSync(out + '.new');
  fs.writeFileSync(src, JSON.stringify({ data: { resources: { ipv4: ['1.2.3.0/24'] } } }));
  run();
  assert.ok(!fs.existsSync(out + '.new'), 'недокачанный список не пишем — остаётся прошлый');
  fs.writeFileSync(src, '{"data":');
  run();
  assert.ok(!fs.existsSync(out + '.new'), 'битый ответ не пишем');
});

/** Каталог «сервера»: opt/server.json как после установки. */
function serverRoot(): { root: string; target: string } {
  const root = dir();
  fs.mkdirSync(path.join(root, 'opt'), { recursive: true });
  const target = path.join(root, 'opt', 'server.json');
  fs.renameSync(installed(root), target);
  return { root, target };
}

/** Прогнать скрипт сервера в bash с заглушками. log — журнал вызовов заглушек. */
function runServerScript(on: boolean, root: string, opts: { xrayTestFails?: boolean; awg?: boolean; ripeCount?: number } = {}) {
  const log = path.join(root, 'calls.log');
  const ripe = path.join(root, 'ripe.json');
  const nets = Array.from({ length: opts.ripeCount ?? 1200 }, (_, i) => `31.${(i >> 8) & 255}.${i & 255}.0/24`);
  fs.writeFileSync(ripe, JSON.stringify({ data: { resources: { ipv4: nets } } }));
  const r = root.replace(/\\/g, '/');
  const py = PY!;
  const stubs = `
set -u
log(){ echo "$*" >> '${log.replace(/\\/g, '/')}'; }
python3(){ command ${py} "$@"; }
docker(){
  log "docker $*"
  case "$1" in
    inspect) return 0;;
    exec)
      if [ "$3" = "xray" ]; then ${opts.xrayTestFails ? 'return 23' : 'return 0'}; fi
      return 0;;
    restart) return 0;;
  esac
}
timeout(){ shift; "$@"; }
ip(){ log "ip $*"; ${opts.awg === false ? 'return 1' : 'return 0'}; }
nft(){ log "nft $*"; return 0; }
curl(){ log "curl"; local o=""; while [ $# -gt 0 ]; do [ "$1" = "-o" ] && o="$2"; shift; done; cp '${ripe.replace(/\\/g, '/')}' "$o"; }
systemctl(){ log "systemctl $*"; return 0; }
`;
  const body = ruGuardScript(on)
    .replaceAll('/opt/amnezia/xray', `${r}/opt`)
    .replaceAll('/etc/novpn', `${r}/etc`)
    .replaceAll('/etc/systemd/system', `${r}/systemd`)
    .replaceAll('/tmp/novpn-ru4.json', `${r}/dl.json`)
    .replaceAll('/usr/sbin/nft', 'nft');
  fs.mkdirSync(path.join(root, 'opt'), { recursive: true });
  fs.mkdirSync(path.join(root, 'systemd'), { recursive: true });
  const sh = path.join(root, 'run.sh');
  fs.writeFileSync(sh, stubs + body);
  const res = spawnSync('bash', [sh], { encoding: 'utf8' });
  return { out: res.stdout + res.stderr, calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' };
}

test('скрипт сервера: включение правит Xray и ставит таблицу AWG, повтор — без рестарта', { skip: noTools }, () => {
  const { root } = serverRoot();
  const a = runServerScript(true, root);
  assert.deepEqual(parseRuGuard(a.out), { xray: 'on', awg: 'on', nets: 1200 }, a.out);
  const c = read(path.join(root, 'opt', 'server.json'));
  assert.ok(c.outbounds.some((o: any) => o.tag === 'ru-block'));
  assert.ok(!fs.existsSync(path.join(root, 'opt', 'server.next.json')), 'временный файл убран');
  assert.match(a.calls, /docker exec amnezia-xray xray -test -config .*server\.next\.json/, 'проверка до подмены');
  assert.match(a.calls, /docker restart amnezia-xray/);
  // nft: сначала проверка (-c), потом применение, затем юнит на перезагрузку.
  const nftCalls = a.calls.split('\n').filter((l) => l.startsWith('nft '));
  assert.match(nftCalls[0]!, /^nft -c -f /);
  assert.match(nftCalls[1]!, /^nft -f /);
  assert.match(a.calls, /systemctl enable novpn-ruguard/);
  const nftFile = fs.readFileSync(path.join(root, 'etc', 'ruguard.nft'), 'utf8');
  assert.match(nftFile, /^table inet novpn_ruguard\ndelete table inet novpn_ruguard\ntable inet novpn_ruguard \{/, 'замена атомарная: создать-удалить-объявить');
  assert.match(nftFile, /flags interval/);
  assert.match(nftFile, /elements = \{ 31\.0\.0\.0\/24,31\.0\.1\.0\/24,.*31\.4\.175\.0\/24 \}/);
  assert.match(nftFile, /type filter hook forward priority -5; policy accept;/, 'чужой трафик пропускаем');
  assert.match(nftFile, /iifname "awg0" ip daddr @ru4 meta l4proto tcp reject with tcp reset/);
  const unit = fs.readFileSync(path.join(root, 'systemd', 'novpn-ruguard.service'), 'utf8');
  assert.match(unit, /ExecStart=nft -f .*ruguard\.nft/);

  const b = runServerScript(true, root);
  assert.equal(parseRuGuard(b.out).xray, 'same', b.out);
  assert.ok(!/docker restart/.test(b.calls.split('\n').slice(a.calls.split('\n').length - 1).join('\n')), 'повтор не рвёт соединения');
});

test('скрипт сервера: Xray отверг конфиг — рабочий не тронут, итог bad', { skip: noTools }, () => {
  const { root, target } = serverRoot();
  const before = fs.readFileSync(target, 'utf8');
  const a = runServerScript(true, root, { xrayTestFails: true });
  assert.equal(parseRuGuard(a.out).xray, 'bad', a.out);
  assert.equal(fs.readFileSync(target, 'utf8'), before);
  assert.ok(!/docker restart/.test(a.calls));
  assert.ok(!fs.existsSync(path.join(root, 'opt', 'server.next.json')));
});

test('скрипт сервера: без AWG таблицу не ставим; недокачанный список — nolist', { skip: noTools }, () => {
  const { root } = serverRoot();
  assert.equal(parseRuGuard(runServerScript(true, root, { awg: false }).out).awg, 'none');
  const { root: root2 } = serverRoot();
  const r = runServerScript(true, root2, { ripeCount: 10 });
  assert.equal(parseRuGuard(r.out).awg, 'nolist', r.out);
  assert.ok(!/nft -f/.test(r.calls), 'без списка правило не применяется');
});

test('скрипт сервера: выключение снимает таблицу и юнит, Xray возвращается к исходному', { skip: noTools }, () => {
  const { root, target } = serverRoot();
  const orig = fs.readFileSync(target, 'utf8');
  runServerScript(true, root);
  const off = runServerScript(false, root);
  assert.deepEqual(parseRuGuard(off.out), { xray: 'off', awg: 'off' }, off.out);
  assert.deepEqual(read(target), JSON.parse(orig));
  assert.match(off.calls, /nft delete table inet novpn_ruguard/);
  assert.match(off.calls, /systemctl disable novpn-ruguard/);
  assert.ok(!fs.existsSync(path.join(root, 'systemd', 'novpn-ruguard.service')));
  assert.ok(!/curl/.test(off.calls.split('nft delete')[1] ?? ''), 'выключение ничего не качает');
});

test('скрипт сервера синтаксически цел в обоих режимах', { skip: noBash }, () => {
  for (const on of [true, false]) {
    const r = spawnSync('bash', ['-n'], { input: ruGuardScript(on), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
});

test('итог в журнале — человеческими словами', () => {
  assert.deepEqual(parseRuGuard('...\nRUGUARD_XRAY=same\nRUGUARD_AWG=on 11494\n'), { xray: 'same', awg: 'on', nets: 11494 });
  assert.deepEqual(parseRuGuard('обрыв'), { xray: 'unknown', awg: 'unknown' });
  assert.equal(formatRuGuard({ xray: 'on', awg: 'on', nets: 11494 }), 'Xray — включено; AmneziaWG — включено (11494 сетей)');
  assert.equal(formatRuGuard({ xray: 'none', awg: 'none' }), 'Xray не установлен; AmneziaWG не установлен');
});

test('домашний и российский сервер защиту не получают никогда', () => {
  assert.equal(ruGuardEligible({ name: '🇫🇷🚀 Франция 1', country: 'FR' }), true);
  assert.equal(ruGuardEligible({ name: 'Франция', country: 'fr', flagEmoji: null }), true);
  assert.equal(ruGuardEligible({ name: '🏠 HomeVPN', country: null }), false, 'значок в имени');
  assert.equal(ruGuardEligible({ name: 'HomeVPN', country: 'FI', flagEmoji: '🏠' }), false, 'свой значок');
  assert.equal(ruGuardEligible({ name: 'Дом', country: 'RU' }), false, 'сервер в России');
  assert.equal(ruGuardEligible({ name: 'Франция', country: 'FR', detached: true }), false, 'отвязанный — без SSH');
});
