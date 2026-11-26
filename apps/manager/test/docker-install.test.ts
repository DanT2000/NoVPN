// Установка Docker и образа Xray на новый сервер, когда сеть хостера подменяет сертификат
// get.docker.com (26.11.2026, новый сервер: «curl: (60) … no alternative certificate subject
// name matches target host name 'get.docker.com'»). Раньше установка на этом обрывалась.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'novpn-dock-'));
process.env.DATABASE_PATH = path.join(tmp, 'database.sqlite');
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.SESSION_SECRET = 'test-secret';
const { buildInstallScript, DOCKER_SH, XRAY_IMAGE } = await import('../src/services/sshServer.js');

const P = { Jc: 4, Jmin: 9, Jmax: 48, S1: 23, S2: 94, H1: 2012218649, H2: 1501317059, H3: 1076010440, H4: 1064530999 };
const script = buildInstallScript({ sni: 'www.lenovo.com', realityPriv: 'x', shortId: 'ab', awgPriv: 'y', xray: true, awg: false, awgParams: P, xrayPort: 443, awgPort: 443 });

test('скрипт установки: get.docker.com не идёт прямо в sh, есть запасные пути', () => {
  assert.doesNotMatch(script, /get\.docker\.com \| sh/);
  assert.match(script, /install -y -qq docker\.io/);
  assert.match(script, /novpn_pull ['"]?teddysun\/xray/);
  assert.ok(script.includes(DOCKER_SH));
});

// bash: на Windows — из Git (не WSL-заглушка из System32), иначе из PATH.
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';
const BASH = process.platform === 'win32' ? (fs.existsSync(GIT_BASH) ? GIT_BASH : null) : 'bash';
const skip = !BASH || spawnSync(BASH, ['-c', 'true']).status !== 0 ? 'нет bash' : false;
// Где Docker стоит по-настоящему, проверку «Docker так и не появился» не провести.
const skipNoDocker = skip || (spawnSync(BASH!, ['-c', 'PATH=/usr/bin:/bin command -v docker']).status === 0 ? 'Docker уже стоит в системе' : false);

/** Прогон функций DOCKER_SH с подменёнными curl/apt-get/docker в отдельном каталоге. */
function sandbox(stubs: Record<string, string>, body: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novpn-dsh-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  for (const [name, code] of Object.entries(stubs)) fs.writeFileSync(path.join(bin, name), '#!/bin/sh\n' + code + '\n', { mode: 0o755 });
  const sh = `set -e
export STUB="$(cd "$(dirname "$0")" && pwd)"; export PATH="$STUB/bin:/usr/bin:/bin"
${DOCKER_SH}
${body}`;
  fs.writeFileSync(path.join(dir, 'run.sh'), sh);
  const r = spawnSync(BASH!, [path.join(dir, 'run.sh').replace(/\\/g, '/')], { encoding: 'utf8' });
  const calls = fs.existsSync(path.join(dir, 'calls')) ? fs.readFileSync(path.join(dir, 'calls'), 'utf8') : '';
  fs.rmSync(dir, { recursive: true, force: true });
  return { code: r.status, out: r.stdout, err: r.stderr, calls };
}

const CURL_MITM = `echo "curl: (60) SSL: no alternative certificate subject name matches target host name 'get.docker.com'" >&2; exit 60`;
// apt-get ставит «docker» (заглушку) только на install docker.io.
const APT_OK = `echo "apt-get $*" >> "$STUB/calls"; case "$*" in *"install"*"docker.io"*) printf '#!/bin/sh\\nexit 0\\n' > "$STUB/bin/docker"; chmod +x "$STUB/bin/docker";; esac; exit 0`;

test('сертификат get.docker.com подменён → Docker из пакета docker.io', { skip: skipNoDocker }, () => {
  const r = sandbox({ curl: CURL_MITM, 'apt-get': APT_OK }, 'novpn_install_docker; command -v docker >/dev/null && echo DOCKER_OK');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /DOCKER_OK/);
  assert.match(r.calls, /install -y -qq docker\.io/);
  // Сообщение curl не уходит в поток ошибок (его панель показывает как причину сбоя).
  assert.doesNotMatch(r.err, /curl: \(60\)/);
});

test('get.docker.com работает → docker.io не трогаем', { skip: skipNoDocker }, () => {
  // «Скрипт get.docker.com» в заглушке просто кладёт заглушку docker.
  const r = sandbox({
    curl: `out=""; while [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done
cat > "$out" <<'EOF'
printf '#!/bin/sh\\nexit 0\\n' > "$STUB/bin/docker"; chmod +x "$STUB/bin/docker"
EOF
exit 0`,
    'apt-get': APT_OK,
  }, 'novpn_install_docker; command -v docker >/dev/null && echo DOCKER_OK');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /DOCKER_OK/);
  assert.equal(r.calls, '');
});

test('ни скрипт, ни пакет → функция возвращает ошибку, а не «успех»', { skip: skipNoDocker }, () => {
  const r = sandbox({ curl: CURL_MITM, 'apt-get': `echo "apt-get $*" >> "$STUB/calls"; exit 100` }, 'novpn_install_docker && echo BAD || echo NO_DOCKER');
  assert.match(r.out, /NO_DOCKER/);
  assert.doesNotMatch(r.out, /BAD/);
});

const DOCKER_HUB_DOWN = `echo "docker $*" >> "$STUB/calls"; case "$1 $2" in
"image inspect") exit 1;;
"pull -q") case "$3" in mirror.gcr.io/*) exit 0;; *) exit 1;; esac;;
"tag "*) exit 0;;
esac; exit 1`;

test('Docker Hub недоступен → образ Xray с mirror.gcr.io и тег под прежним именем', { skip }, () => {
  const r = sandbox({ docker: DOCKER_HUB_DOWN }, `novpn_pull ${XRAY_IMAGE} && echo PULLED`);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /PULLED/);
  assert.ok(r.calls.includes(`docker pull -q mirror.gcr.io/${XRAY_IMAGE}`), r.calls);
  assert.ok(r.calls.includes(`docker tag mirror.gcr.io/${XRAY_IMAGE} ${XRAY_IMAGE}`), r.calls);
});

test('образ уже есть → ничего не качаем', { skip }, () => {
  const r = sandbox({ docker: `echo "docker $*" >> "$STUB/calls"; [ "$1 $2" = "image inspect" ] && exit 0; exit 1` }, `novpn_pull ${XRAY_IMAGE} && echo HAVE`);
  assert.match(r.out, /HAVE/);
  assert.doesNotMatch(r.calls, /pull/);
});

test('образ нигде не скачался → ошибка', { skip }, () => {
  const r = sandbox({ docker: `echo "docker $*" >> "$STUB/calls"; exit 1` }, `novpn_pull ${XRAY_IMAGE} && echo BAD || echo NO_IMAGE`);
  assert.match(r.out, /NO_IMAGE/);
});

test('собранный скрипт установки синтаксически цел', { skip }, () => {
  const r = spawnSync(BASH!, ['-n'], { input: script, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});
