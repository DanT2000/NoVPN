// Защита SSH (05.11.2026): боты подбирали пароль root и занимали все места до входа —
// sshd сбрасывал саму панель, приходило ложное «сервер недоступен». Защита включается
// владельцем сервера по желанию. Главное: адрес панели всегда разрешён и не банится,
// а адреса из формы, уходящие в shell и iptables, — только IPv4/CIDR.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const tmp = path.join(os.tmpdir(), `novpn-sshguard-${process.pid}-${Math.floor(process.hrtime()[1])}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.DATABASE_PATH = path.join(tmp, 'database.sqlite');
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.SESSION_SECRET = 'test-secret';

const { sshGuardApplyScript, sshGuardOffScript, sshAllowFwScript, SSH_GUARD_CONFIRM_SCRIPT, installCheckScript, parseInstallCheck } = await import('../src/services/sshServer.js');
const { noteUnreachable, settleUnreachable, UNREACHABLE_STREAK } = await import('../src/services/sync.js');
const repo = await import('../src/repo.js');

const noBash = spawnSync('bash', ['--version']).error ? 'bash недоступен' : false;
const PANEL = '188.18.55.140';

test('подбор пароля: лимиты sshd, fail2ban, адрес панели в исключениях', () => {
  const s = sshGuardApplyScript({ bruteforce: true, allow: [] }, 22, [PANEL]);
  assert.ok(s.includes('PerSourceMaxStartups 4'));
  assert.ok(s.includes('MaxStartups 30:30:100'));
  assert.ok(s.includes('LoginGraceTime 30'));
  assert.match(s, /^ignoreip = 127\.0\.0\.1\/8 ::1 188\.18\.55\.140$/m);
  assert.match(s, /^maxretry = 3$/m);
  assert.match(s, /^bantime  = 1d$/m);
  // Без списка адресов файрвол входа не ставится, а прежний — снимается.
  assert.ok(!s.includes('/opt/novpn/ssh-allow.sh <<'));
  assert.ok(s.includes('systemctl disable --now novpn-ssh-allow'));
  // Страховка взводится ДО изменений.
  assert.ok(s.indexOf('systemd-run') < s.indexOf('MaxStartups'));
  assert.ok(s.trimEnd().endsWith('echo "GUARD_OK=1"'));
});

test('вход только с адресов: адрес панели добавлен сам, мусор отброшен', () => {
  const s = sshGuardApplyScript({ bruteforce: false, allow: ['203.0.113.7', '1.2.3.4; reboot', '198.51.100.0/24', '$(id)'] }, 2222, [PANEL]);
  assert.match(s, /^ALLOW="188\.18\.55\.140 203\.0\.113\.7 198\.51\.100\.0\/24"$/m);
  assert.match(s, /^PORT=2222$/m);
  assert.ok(!s.includes('reboot') && !s.includes('$(id)'));
  assert.ok(s.includes('novpn-ssh-allow.service'));
  // Подбор пароля не включён — его файлы убираются.
  assert.ok(!s.includes('PerSourceMaxStartups 4'));
  assert.ok(s.includes('rm -f /etc/ssh/sshd_config.d/10-novpn-bruteforce.conf'));
});

test('файрвол входа: свои адреса и lo пропускаются, остальные режутся, IPv6 закрыт', () => {
  const s = sshAllowFwScript(22, ['203.0.113.7', 'bad']);
  assert.match(s, /^ALLOW="203\.0\.113\.7"$/m);
  assert.ok(s.includes('-A NOVPN_SSH -i lo -j RETURN'));
  assert.ok(s.includes('-A NOVPN_SSH -j DROP'));
  assert.ok(s.includes('ip6tables -C INPUT -p tcp --dport $PORT -j DROP'));
});

test('снятие защиты: только своё, чужой fail2ban остаётся работать', () => {
  const s = sshGuardOffScript(22);
  assert.ok(s.includes('rm -f /etc/ssh/sshd_config.d/10-novpn-bruteforce.conf'));
  assert.ok(s.includes('rm -f /etc/fail2ban/jail.d/novpn.local'));
  assert.ok(s.includes('jail.local'));
  assert.ok(s.includes('iptables -X NOVPN_SSH'));
});

test('сгенерированные скрипты проходят bash -n', { skip: noBash }, () => {
  for (const [name, body] of [
    ['bf.sh', sshGuardApplyScript({ bruteforce: true, allow: [] }, 22, [PANEL])],
    ['both.sh', sshGuardApplyScript({ bruteforce: true, allow: ['203.0.113.7'] }, 22, [PANEL])],
    ['allow.sh', sshGuardApplyScript({ bruteforce: false, allow: ['203.0.113.0/24'] }, 22, [PANEL])],
    ['off.sh', sshGuardOffScript(22)],
    ['confirm.sh', SSH_GUARD_CONFIRM_SCRIPT],
  ] as const) {
    const f = path.join(tmp, name);
    fs.writeFileSync(f, body);
    const r = spawnSync('bash', ['-n', f], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
  }
});

/** Самопроверка на «сервере»: f2b — активен ли fail2ban, rule — есть ли правило входа. */
function check(script: string, st: { f2b: boolean; rule: boolean }): string {
  const stub = [
    `systemctl() { return ${st.f2b ? 0 : 1}; }`,
    `iptables() { return ${st.rule ? 0 : 1}; }`,
  ].join('\n');
  return spawnSync('bash', [], { input: `${stub}\n${script}\n`, encoding: 'utf8' }).stdout;
}

test('самопроверка: защита на месте / пропала', { skip: noBash }, () => {
  const allowOnly = installCheckScript({ sshGuard: { bruteforce: false, allow: true, port: 22 } }, {});
  let c = parseInstallCheck(check(allowOnly, { f2b: false, rule: true }));
  assert.deepEqual(c.map((x) => [x.key, x.ok, x.detail]), [['sshguard', true, 'вход только с разрешённых адресов']]);
  c = parseInstallCheck(check(allowOnly, { f2b: true, rule: false }));
  assert.equal(c[0]!.ok, false);
  // fail2ban остановлен — защита не работает, даже если файл на месте.
  const bf = installCheckScript({ sshGuard: { bruteforce: true, allow: false, port: 22 } }, {});
  c = parseInstallCheck(check(bf, { f2b: false, rule: true }));
  assert.deepEqual(c.map((x) => [x.name, x.ok, x.detail]), [['Защита SSH', false, 'fail2ban не работает']]);
  // Не включена в панели — не проверяется вовсе.
  assert.equal(installCheckScript({ sshGuard: null }, {}), '');
});

test('«сервер недоступен» — только если связи не было два прохода подряд', () => {
  assert.equal(UNREACHABLE_STREAK, 2);
  const count = () => repo.listJobErrors(100).filter((e) => e.server === 'Франция').length;
  // Одна сорвавшаяся попытка, следующий проход успешный — тишина.
  noteUnreachable('s_fr', 'Timed out while waiting for handshake');
  assert.equal(settleUnreachable('Франция', 's_fr'), 1);
  assert.equal(settleUnreachable('Франция', 's_fr'), 0);
  assert.equal(count(), 0);
  // Два прохода подряд без связи — одна запись (она же уведомление).
  noteUnreachable('s_fr', 'Timed out while waiting for handshake');
  noteUnreachable('s_fr', 'read ECONNRESET'); // несколько операций в одном проходе — один счёт
  assert.equal(settleUnreachable('Франция', 's_fr'), 1);
  assert.equal(count(), 0);
  noteUnreachable('s_fr', 'Timed out while waiting for handshake');
  assert.equal(settleUnreachable('Франция', 's_fr'), 2);
  assert.equal(count(), 1);
  assert.match(repo.listJobErrors(1)[0]!.text, /^Сервер недоступен: Timed out while waiting for handshake \(нет связи 2 прохода подряд\)$/);
  // Третий проход подряд — без повтора (не чаще раза в 30 минут).
  noteUnreachable('s_fr', 'Timed out while waiting for handshake');
  assert.equal(settleUnreachable('Франция', 's_fr'), 3);
  assert.equal(count(), 1);
  // Связь вернулась (проход целиком успешный), потом новый сбой — сообщаем заново.
  assert.equal(settleUnreachable('Франция', 's_fr'), 0);
  noteUnreachable('s_fr', 'Connection lost before handshake');
  settleUnreachable('Франция', 's_fr');
  noteUnreachable('s_fr', 'Connection lost before handshake');
  settleUnreachable('Франция', 's_fr');
  assert.equal(count(), 2);
});
