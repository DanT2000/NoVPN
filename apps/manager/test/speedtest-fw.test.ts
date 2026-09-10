// Тест скорости на сервере: список адресов уходит в shell и iptables, поэтому
// валидатор должен пропускать только IPv4/CIDR, а сгенерированные скрипты —
// быть синтаксически верным sh (heredoc внутри heredoc легко сломать).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const tmp = path.join(os.tmpdir(), `novpn-speedtest-${process.pid}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.DATABASE_PATH = path.join(tmp, 'database.sqlite');
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.SESSION_SECRET = 'test-secret';

const { isAllowEntry, speedtestFwScript, speedtestInstallScript, parseSelfTest, SELF_SPEEDTEST_SCRIPT } = await import('../src/services/sshServer.js');

test('isAllowEntry: только IPv4 и IPv4/CIDR', () => {
  for (const ok of ['1.2.3.4', '10.0.0.0/8', '192.168.2.0/24', ' 8.8.8.8 ']) assert.equal(isAllowEntry(ok), true, ok);
  for (const bad of ['', 'abc', '1.2.3', '1.2.3.256', '1.2.3.4/33', '::1', '1.2.3.4; rm -rf /', '1.2.3.4 5.6.7.8', '$(id)'])
    assert.equal(isAllowEntry(bad), false, bad);
});

test('скрипт файрвола: порт, адреса, DOCKER-USER, мусор отфильтрован', () => {
  const s = speedtestFwScript(3000, ['1.2.3.4', 'evil; reboot', '10.0.0.0/8']);
  assert.match(s, /^PORT=3000$/m);
  assert.match(s, /^ALLOW="1\.2\.3\.4 10\.0\.0\.0\/8"$/m);
  assert.ok(!s.includes('reboot'));
  assert.ok(s.includes('DOCKER-USER'));
  assert.ok(s.includes('--ctorigdstport $PORT --ctdir ORIGINAL'));
  assert.ok(s.includes('-j DROP'));
  // Пустой список — закрыто для всех: цепочка состоит из одного DROP.
  assert.match(speedtestFwScript(3000, []), /^ALLOW=""$/m);
});

test('скрипт установки: контейнер, автозагрузка файрвола, маркер успеха', () => {
  const s = speedtestInstallScript(3000, ['1.2.3.4']);
  assert.ok(s.includes('docker run -d --name novpn-speedtest'));
  assert.ok(s.includes('-p $PORT:3000 openspeedtest/latest'));
  assert.ok(s.includes('novpn-speedtest-fw.service'));
  assert.ok(s.includes('echo "SPEED_OK=$PORT"'));
  // Вложенный heredoc файрвола закрыт своим маркером.
  assert.ok(/<<'FW'\n#!\/bin\/sh[\s\S]*\nexit 0\nFW\n/.test(s));
});

// bash -n есть на Linux/CI и в Git Bash; где его нет — пропускаем, а не падаем.
const sh = spawnSync('bash', ['--version']);
test('сгенерированные скрипты проходят bash -n', { skip: sh.error ? 'bash недоступен' : false }, () => {
  for (const [name, body] of [
    ['fw.sh', speedtestFwScript(3000, ['1.2.3.4', '10.0.0.0/8'])],
    ['install.sh', speedtestInstallScript(3000, ['1.2.3.4'])],
    ['self.sh', SELF_SPEEDTEST_SCRIPT],
  ] as const) {
    const f = path.join(tmp, name);
    fs.writeFileSync(f, body);
    const r = spawnSync('bash', ['-n', f], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
  }
});

test('самотест: разбор Ookla (байты/с) и speedtest-cli (бит/с), ошибка без вывода', () => {
  const ookla = JSON.stringify({
    download: { bandwidth: 1_212_500_000 }, upload: { bandwidth: 118_750_000 }, ping: { latency: 1.234 },
    server: { name: 'Orange', location: 'Paris', country: 'France' }, isp: 'OVH', result: { url: 'https://www.speedtest.net/result/c/x' },
  });
  const r = parseSelfTest(`junk
OOKLA=${ookla}
`);
  assert.equal(r.downloadMbps, 9700);
  assert.equal(r.uploadMbps, 950);
  assert.equal(r.pingMs, 1.2);
  assert.equal(r.server, 'Orange, Paris, France');
  assert.equal(r.tool, 'ookla');
  const py = JSON.stringify({ download: 487_000_000, upload: 92_500_000, ping: 12.5, server: { sponsor: 'Beeline', name: 'Moscow', country: 'Russia' }, client: { isp: 'Rostelecom' } });
  const p = parseSelfTest(`PYST=${py}`);
  assert.equal(p.downloadMbps, 487);
  assert.equal(p.uploadMbps, 92.5);
  assert.equal(p.tool, 'speedtest-cli');
  assert.equal(p.server, 'Beeline, Moscow, Russia');
  assert.throws(() => parseSelfTest('SELF_FAIL: ничего не вышло'), /ничего не вышло/);
});
