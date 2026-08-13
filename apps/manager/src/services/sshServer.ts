// Выпуск/отзыв конфигов на VPN-сервере ПО SSH (manager → сервер).
// Лёгкий путь без агента на самом VPS (важно для сервера с 1GB RAM):
// panel по SSH выполняет те же команды (xray через docker exec, awg через awg set).

import { Client } from 'ssh2';
import type { Server } from '@novpn/shared';
import { decryptSecret } from '../lib/crypto.js';
import { getServerSsh } from '../repo.js';
import { getServerKeys } from './keyvault.js';

// Параметры маскировки Xray-reality. SNI vk.com оказался заезжен reality-серверами
// и режется российским DPI (проверено на реальной сети: vk.com виснет, а
// cdn.dodostatic.net проходит). fingerprint edge + spiderX '/' — как в рабочих
// конфигах. dest (reality-стил) указывает на тот же домен, он отдаёт TLS 1.3.
export const REALITY_SNI = 'cdn.dodostatic.net';
export const REALITY_FP = 'edge';
export const REALITY_SPX = '/';

function creds(serverId: string) {
  const s = getServerSsh(serverId);
  if (!s) throw new Error('Сервер не найден.');
  if (!s.passwordEnc) throw new Error('Для сервера не задан SSH-доступ — выпуск конфигов невозможен.');
  const secret = decryptSecret(s.passwordEnc);
  // Приватный ключ или пароль — определяем по содержимому.
  const auth = /PRIVATE KEY/.test(secret) ? { privateKey: secret } : { password: secret };
  return { host: s.host, port: s.port, username: s.user, ...auth };
}

function runScript(
  c: { host: string; port: number; username: string; password?: string; privateKey?: string },
  script: string,
  timeoutMs = 30000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      conn.end();
      reject(new Error('SSH: таймаут'));
    }, timeoutMs);
    conn.on('ready', () => {
      conn.exec('bash -s', (e, stream) => {
        if (e) {
          clearTimeout(timer);
          conn.end();
          return reject(e);
        }
        stream.on('close', (code: number) => {
          clearTimeout(timer);
          conn.end();
          code === 0 ? resolve(out) : reject(new Error(`SSH exit ${code}: ${err.slice(0, 300)}`));
        });
        stream.on('data', (d: Buffer) => (out += d.toString()));
        stream.stderr.on('data', (d: Buffer) => (err += d.toString()));
        stream.end(script);
      });
    });
    conn.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    conn.connect({ host: c.host, port: c.port, username: c.username, password: c.password, privateKey: c.privateKey, readyTimeout: 15000 });
  });
}

const san = (n: string) => (n.replace(/[^\w .-]/g, '').trim().slice(0, 40) || 'device');
const grab = (out: string, k: string) => out.match(new RegExp('^' + k + '=(.+)$', 'm'))?.[1]?.trim();

// Защита от инъекции в удалённые shell/python-скрипты. Для штатно выпущенных
// конфигов значения генерирует сам сервер (uuid из /proc/…/random/uuid, ключи awg),
// но uuid/public_key/ip могут прийти и из ИМПОРТА чужой БД или от админа. Пропускаем
// в скрипт ТОЛЬКО строго ожидаемый алфавит; иначе — отказ (или пропуск в bulk-resync).
const isUuid = (v: string | null | undefined): v is string => !!v && /^[0-9a-fA-F-]{8,64}$/.test(v);
const isWgKey = (v: string | null | undefined): v is string => !!v && /^[A-Za-z0-9+/=]{40,50}$/.test(v);
const isIpv4 = (v: string | null | undefined): v is string =>
  !!v && /^(\d{1,3}\.){3}\d{1,3}$/.test(v) && v.split('.').every((o) => Number(o) <= 255);
function assertUuid(v: string): string {
  if (!isUuid(v)) throw new Error('Некорректный идентификатор клиента (uuid).');
  return v;
}
function assertWgKey(v: string): string {
  if (!isWgKey(v)) throw new Error('Некорректный публичный ключ.');
  return v;
}

// Последовательный доступ к серверу: правки server.json/awg0.conf нельзя делать
// параллельно (иначе гонка → битый конфиг → xray -test падает, exit 23).
const serverLocks = new Map<string, Promise<unknown>>();
function withServerLock<T>(serverId: string, fn: () => Promise<T>): Promise<T> {
  const prev = serverLocks.get(serverId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  serverLocks.set(
    serverId,
    run.catch(() => {}),
  );
  return run;
}

// ── Параметры обфускации AmneziaWG ──
// ВАЖНО: они должны быть УНИКАЛЬНЫ для каждого сервера. Если у всех серверов
// одинаковые «магические» H1..H4, само это число становится подписью → DPI может
// заблокировать все наши серверы одним правилом. Параметры кладём в keyvault
// рядом с ключами: восстановление по домену возвращает и ключ, и параметры,
// поэтому ранее выданные конфиги продолжают работать.
export interface AwgParams {
  Jc: number; Jmin: number; Jmax: number;
  S1: number; S2: number;
  H1: number; H2: number; H3: number; H4: number;
}

const rnd = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));

export function genAwgParams(): AwgParams {
  const Jmin = rnd(8, 40);
  const Jmax = Math.min(1280, Jmin + rnd(20, 60));
  const S1 = rnd(15, 120);
  let S2 = rnd(15, 120);
  while (S2 === S1 + 56) S2 = rnd(15, 120); // требование AmneziaWG: S1+56 ≠ S2
  const hs = new Set<number>();
  while (hs.size < 4) hs.add(rnd(5, 2147483600)); // > 4, чтобы не совпасть с типами WireGuard
  const [H1, H2, H3, H4] = [...hs];
  return { Jc: rnd(3, 10), Jmin, Jmax, S1, S2, H1: H1!, H2: H2!, H3: H3!, H4: H4! };
}

/** Прочитать параметры уже установленного awg0 (чтобы НЕ менять их при переустановке). */
export async function sshReadAwgParams(server: Server): Promise<AwgParams | null> {
  try {
    const out = await runScript(
      creds(server.id),
      `CONF=/etc/amnezia/amneziawg/awg0.conf
[ -f "$CONF" ] || { echo NONE; exit 0; }
p(){ awk -F'= ' -v k="$1" 'index($0,k" ")==1{print $2; exit}' "$CONF"; }
for k in Jc Jmin Jmax S1 S2 H1 H2 H3 H4; do echo "$k=$(p $k)"; done`,
      20000,
    );
    if (/NONE/.test(out)) return null;
    const num = (k: string) => {
      const v = grab(out, k);
      const n = v ? Number(v) : NaN;
      return Number.isFinite(n) ? n : null;
    };
    const p: Record<string, number | null> = {};
    for (const k of ['Jc', 'Jmin', 'Jmax', 'S1', 'S2', 'H1', 'H2', 'H3', 'H4']) p[k] = num(k);
    if (Object.values(p).some((v) => v === null)) return null;
    return p as unknown as AwgParams;
  } catch {
    return null;
  }
}

// ── Провижининг сервера с нуля (xray Reality + AmneziaWG) ──
// Скрипт без bash-${…} (кроме инжектов сверху) — безопасно в JS-шаблоне.
// Параметры обфускации AWG фиксированы → восстановление по домену требует только приватный ключ.
function buildInstallScript(o: {
  sni: string; realityPriv: string; shortId: string; awgPriv: string; xray: boolean; awg: boolean; awgParams: AwgParams;
}): string {
  const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  // Параметры обфускации подставляются в bash БЕЗ кавычек — приводим каждый к целому
  // в разумных границах (защита от инъекции, если awgParams пришли из админ-ввода/импорта).
  const int = (v: unknown, def: number): number => {
    const n = Math.trunc(Number(v));
    return Number.isFinite(n) && n >= 0 && n <= 2000000000 ? n : def;
  };
  const raw = o.awgParams;
  const a = {
    Jc: int(raw.Jc, 4), Jmin: int(raw.Jmin, 40), Jmax: int(raw.Jmax, 70),
    S1: int(raw.S1, 0), S2: int(raw.S2, 0),
    H1: int(raw.H1, 1), H2: int(raw.H2, 2), H3: int(raw.H3, 3), H4: int(raw.H4, 4),
  };
  return `set -e
SNI=${q(o.sni)}
REALITY_PRIV=${q(o.realityPriv)}
SHORT_ID=${q(o.shortId)}
AWG_PRIV=${q(o.awgPriv)}
WANT_XRAY=${o.xray ? '1' : '0'}
WANT_AWG=${o.awg ? '1' : '0'}
IFACE="$(ip route get 8.8.8.8 2>/dev/null | grep -oP 'dev \\K\\S+' | head -1)"
[ -z "$IFACE" ] && IFACE=eth0
# Параметры обфускации — УНИКАЛЬНЫ для сервера (приходят из панели/keyvault).
JC=${a.Jc}; JMIN=${a.Jmin}; JMAX=${a.Jmax}; S1=${a.S1}; S2=${a.S2}
H1=${a.H1}; H2=${a.H2}; H3=${a.H3}; H4=${a.H4}

if [ "$WANT_XRAY" = "1" ]; then
  echo "== xray =="
  mkdir -p /opt/amnezia/xray
  docker pull -q teddysun/xray >/dev/null 2>&1 || true
  if [ -z "$REALITY_PRIV" ]; then
    KP=$(docker run --rm teddysun/xray xray x25519)
    REALITY_PRIV=$(echo "$KP" | grep -iE 'private' | grep -oE '[A-Za-z0-9_/+-]{40,}' | head -1)
  fi
  REALITY_PUB=$(docker run --rm teddysun/xray xray x25519 -i "$REALITY_PRIV" | grep -iE 'public' | grep -oE '[A-Za-z0-9_/+-]{40,}' | head -1)
  [ -z "$SHORT_ID" ] && SHORT_ID=$(openssl rand -hex 8)
  python3 - "$SNI" "$REALITY_PRIV" "$SHORT_ID" > /opt/amnezia/xray/server.json <<'PY'
import json,sys
sni,priv,sid=sys.argv[1],sys.argv[2],sys.argv[3]
cfg={"log":{"loglevel":"warning"},
 # Статистика по клиентам (трафик/активность) — панель читает через api statsquery.
 "stats":{},
 "api":{"tag":"api","services":["StatsService"]},
 "policy":{"levels":{"0":{"statsUserUplink":True,"statsUserDownlink":True}},
           "system":{"statsInboundUplink":True,"statsInboundDownlink":True}},
 "inbounds":[{"listen":"0.0.0.0","port":443,"protocol":"vless","tag":"vless-reality",
   "settings":{"clients":[],"decryption":"none"},
   "streamSettings":{"network":"tcp","security":"reality",
     "realitySettings":{"show":False,"dest":sni+":443","xver":0,
       "serverNames":[sni],"privateKey":priv,"shortIds":[sid]}},
   "sniffing":{"enabled":True,"destOverride":["http","tls","quic"]}},
   {"listen":"127.0.0.1","port":10085,"protocol":"dokodemo-door",
    "settings":{"address":"127.0.0.1"},"tag":"api"}],
 "outbounds":[{"protocol":"freedom","tag":"direct"}],
 "routing":{"rules":[{"type":"field","inboundTag":["api"],"outboundTag":"api"}]}}
print(json.dumps(cfg,indent=2))
PY
  docker rm -f amnezia-xray >/dev/null 2>&1 || true
  docker run -d --name amnezia-xray --restart always -p 443:443 -v /opt/amnezia/xray:/opt/amnezia/xray teddysun/xray xray run -c /opt/amnezia/xray/server.json >/dev/null
  sleep 3
  docker exec amnezia-xray xray -test -config /opt/amnezia/xray/server.json >/dev/null || { echo "XRAY_FAIL"; exit 1; }
  echo "REALITY_PRIV=$REALITY_PRIV"; echo "REALITY_PUB=$REALITY_PUB"; echo "SHORT_ID=$SHORT_ID"; echo "SNI=$SNI"
fi

if [ "$WANT_AWG" = "1" ]; then
  echo "== awg =="
  if ! command -v awg >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    add-apt-repository -y ppa:amnezia/ppa >/tmp/ppa.log 2>&1 || true
    apt-get update -qq >/dev/null 2>&1 || true
    apt-get install -y -qq amneziawg amneziawg-tools >/tmp/awg.log 2>&1 || apt-get install -y -qq amneziawg-tools amneziawg-dkms >>/tmp/awg.log 2>&1 || { echo "AWG_FAIL"; exit 1; }
  fi
  modprobe amneziawg 2>/dev/null || true
  [ -z "$AWG_PRIV" ] && AWG_PRIV=$(awg genkey)
  AWG_PUB=$(printf '%s' "$AWG_PRIV" | awg pubkey)
  mkdir -p /etc/amnezia/amneziawg
  cat > /etc/amnezia/amneziawg/awg0.conf <<CONF
[Interface]
PrivateKey = $AWG_PRIV
Address = 10.8.1.1/24
ListenPort = 51820
Jc = $JC
Jmin = $JMIN
Jmax = $JMAX
S1 = $S1
S2 = $S2
H1 = $H1
H2 = $H2
H3 = $H3
H4 = $H4
PostUp = iptables -t nat -A POSTROUTING -o $IFACE -j MASQUERADE; iptables -A FORWARD -i awg0 -j ACCEPT; iptables -A FORWARD -o awg0 -j ACCEPT
PostDown = iptables -t nat -D POSTROUTING -o $IFACE -j MASQUERADE; iptables -D FORWARD -i awg0 -j ACCEPT; iptables -D FORWARD -o awg0 -j ACCEPT
CONF
  chmod 600 /etc/amnezia/amneziawg/awg0.conf
  sysctl -qw net.ipv4.ip_forward=1
  grep -q '^net.ipv4.ip_forward=1' /etc/sysctl.conf || echo 'net.ipv4.ip_forward=1' >> /etc/sysctl.conf
  awg-quick down awg0 2>/dev/null || true
  awg-quick up awg0
  systemctl enable awg-quick@awg0 >/dev/null 2>&1 || true
  ip link show awg0 >/dev/null || { echo "AWG0_FAIL"; exit 1; }
  echo "AWG_PRIV=$AWG_PRIV"; echo "AWG_PUB=$AWG_PUB"
fi
echo INSTALL_DONE`;
}

// Удаляем ТОЛЬКО то, что ставили сами. Чужой Amnezia/VPN на сервере не трогаем:
// раньше `rm -rf /opt/amnezia` сносил чужую установку вместе с нашей.
function buildUninstallScript(): string {
  return `set +e
# наш xray-контейнер и его конфиг
docker rm -f amnezia-xray 2>/dev/null
rm -rf /opt/amnezia/xray
# наш awg0 на хосте (чужие awg/wg интерфейсы и контейнеры не трогаем)
awg-quick down awg0 2>/dev/null
systemctl disable --now awg-quick@awg0 2>/dev/null
rm -f /etc/amnezia/amneziawg/awg0.conf
rmdir --ignore-fail-on-non-empty /etc/amnezia/amneziawg /etc/amnezia /opt/amnezia 2>/dev/null
# наши прокси
systemctl disable --now 3proxy 2>/dev/null
systemctl disable --now novpn-stunnel 2>/dev/null
rm -f /usr/local/bin/3proxy /etc/systemd/system/3proxy.service /etc/systemd/system/novpn-stunnel.service
rm -rf /etc/3proxy /etc/stunnel/novpn.conf /opt/3proxy-src
systemctl daemon-reload 2>/dev/null
echo UNINSTALL_DONE`;
}

/** Установить VPN-комплект (xray/awg). Если переданы ключи — восстановление по домену. */
export async function sshInstallServer(
  server: Server,
  opts: { xray: boolean; awg: boolean; sni?: string; realityPriv?: string; shortId?: string; awgPriv?: string; awgParams: AwgParams },
): Promise<{ realityPriv?: string; realityPub?: string; shortId?: string; sni?: string; awgPriv?: string; awgPub?: string }> {
  const script = buildInstallScript({
    sni: opts.sni || REALITY_SNI,
    realityPriv: opts.realityPriv || '',
    shortId: opts.shortId || '',
    awgPriv: opts.awgPriv || '',
    xray: opts.xray,
    awg: opts.awg,
    awgParams: opts.awgParams,
  });
  const out = await runScript(creds(server.id), script, 600000);
  if (!/INSTALL_DONE/.test(out)) throw new Error('Установка не завершилась: ' + out.slice(-300));
  return {
    realityPriv: grab(out, 'REALITY_PRIV'),
    realityPub: grab(out, 'REALITY_PUB'),
    shortId: grab(out, 'SHORT_ID'),
    sni: grab(out, 'SNI'),
    awgPriv: grab(out, 'AWG_PRIV'),
    awgPub: grab(out, 'AWG_PUB'),
  };
}

export async function sshUninstallServer(server: Server): Promise<void> {
  await runScript(creds(server.id), buildUninstallScript(), 300000);
}

/** Повторно добавить существующие устройства на переустановленный сервер (восстановление). */
export async function sshResyncDevices(
  server: Server,
  items: Array<{ name: string; protocol: string; uuid?: string | null; awgPub?: string | null; clientIp?: string | null; psk?: string | null }>,
): Promise<void> {
  // Только валидные идентификаторы попадают в удалённый скрипт (см. isUuid/isWgKey/isIpv4):
  // битые/чужие значения из импорта пропускаем, чтобы они не инъектировались в shell/python.
  const xray = items.filter((i) => i.protocol === 'xray' && isUuid(i.uuid)).map((i) => ({ id: i.uuid!, name: san(i.name) }));
  const awg = items.filter(
    (i) => i.protocol === 'amneziawg' && isWgKey(i.awgPub) && isIpv4((i.clientIp || '').split('/')[0]),
  );
  const lines: string[] = ['set +e'];
  if (xray.length) {
    // UUID/имя пишем во временный файл (без встраивания JSON в python -c — иначе
    // двойные кавычки JSON ломают обёртку python3 -c "…").
    lines.push('rm -f /tmp/novpn-xray-clients');
    for (const c of xray) {
      const nm = c.name.replace(/'/g, '');
      lines.push(`printf '%s\\t%s\\n' '${c.id}' '${nm}' >> /tmp/novpn-xray-clients`);
    }
    lines.push(
      `python3 <<'PY'
import json
p="/opt/amnezia/xray/server.json"
c=json.load(open(p))
cl=c["inbounds"][0]["settings"]["clients"]
ex={x.get("id") for x in cl}
for l in open("/tmp/novpn-xray-clients"):
    parts=l.rstrip("\\n").split("\\t")
    u=parts[0]; n=parts[1] if len(parts)>1 else u
    if u and u not in ex:
        cl.append({"id":u,"flow":"xtls-rprx-vision","email":n}); ex.add(u)
seen=set()
for x in cl:
    e=x.get("email") or x["id"]; base=e; i=1
    while e in seen:
        e=base+"-"+str(i); i+=1
    x["email"]=e; seen.add(e)
json.dump(c,open(p,"w"),indent=2)
PY`,
      'docker exec amnezia-xray xray -test -config /opt/amnezia/xray/server.json >/dev/null 2>&1 && docker restart amnezia-xray >/dev/null 2>&1 || true',
    );
  }
  for (const a of awg) {
    const ip = (a.clientIp || '').split('/')[0];
    if (a.psk) {
      lines.push(`printf '%s' '${a.psk.replace(/'/g, "'\\''")}' | awg set awg0 peer '${a.awgPub}' preshared-key /dev/stdin allowed-ips ${ip}/32`);
    } else {
      lines.push(`awg set awg0 peer '${a.awgPub}' allowed-ips ${ip}/32`);
    }
    lines.push(`grep -q '${a.awgPub}' /etc/amnezia/amneziawg/awg0.conf || printf '\\n[Peer]\\nPublicKey = %s\\nAllowedIPs = %s/32\\n' '${a.awgPub}' '${ip}' >> /etc/amnezia/amneziawg/awg0.conf`);
  }
  lines.push('echo RESYNC_DONE');
  await runScript(creds(server.id), lines.join('\n'), 120000);
}

// Сбор статистики AmneziaWG: rx/tx и время последнего рукопожатия по каждому пиру.

export async function sshHasSshAccess(serverId: string): Promise<boolean> {
  const s = getServerSsh(serverId);
  return !!s?.passwordEnc;
}

/** Реальный аудит сервера ДО добавления (креды из формы, сервера в БД ещё нет). */
export async function sshProbe(c: { host: string; port: number; user: string; secret: string }): Promise<Record<string, string>> {
  const auth = /PRIVATE KEY/.test(c.secret) ? { privateKey: c.secret } : { password: c.secret };
  const script = `set +e
. /etc/os-release 2>/dev/null
echo "OS=$PRETTY_NAME"
echo "RAM=$(free -m | awk '/Mem:/{print $2}')"
command -v docker >/dev/null 2>&1 && echo "DOCKER=yes" || echo "DOCKER=no"
[ -f /opt/amnezia/xray/server.json ] && echo "XRAY=yes" || echo "XRAY=no"
(command -v awg >/dev/null 2>&1 || ls /etc/amnezia/amneziawg/*.conf >/dev/null 2>&1) && echo "AWG=yes" || echo "AWG=no"
VPNC=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -iE 'amnezia|xray|wg|marzban|x-ui' | tr '\\n' ',' | sed 's/,$//')
echo "VPNC=$VPNC"
for p in 443 51820 80; do
  if ss -tuln 2>/dev/null | grep -qE "[:.]$p " ; then echo "P$p=busy"; else echo "P$p=free"; fi
done
echo PROBE_DONE`;
  const out = await runScript({ host: c.host, port: c.port, username: c.user, ...auth }, script, 25000);
  const res: Record<string, string> = {};
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && m[1]) res[m[1]] = (m[2] ?? '').trim();
  }
  return res;
}

export async function sshCreateXray(server: Server, deviceName: string): Promise<{ uuid: string; link: string; publicKey: string }> {
  const keys = getServerKeys(server.host);
  const pbk = keys?.xrayRealityPubKey;
  const sid = keys?.xrayShortId;
  const sni = keys?.xraySni;
  if (!pbk || !sid || !sni) throw new Error('В панели нет reality-ключей этого сервера. Переустановите/зарегистрируйте сервер.');
  const nm = san(deviceName);
  const email = `${nm}-${Math.floor(Math.random() * 1e9).toString(36)}`; // уникальный email клиента
  // Сериализуем правки конфига (иначе гонка → битый server.json → exit 23).
  // Плюс делаем email всех клиентов уникальными (xray требует уникальный email,
  // иначе -test падает «User … already exists») — самоисцеление старых дублей.
  const out = await withServerLock(server.id, () => {
    const script = `set -e
UUID=$(cat /proc/sys/kernel/random/uuid)
for i in $(seq 1 15); do docker exec amnezia-xray true 2>/dev/null && break; sleep 1; done
python3 - "$UUID" '${email}' <<'PY'
import json,sys
uuid,email=sys.argv[1],sys.argv[2]
p='/opt/amnezia/xray/server.json'
c=json.load(open(p))
cl=c['inbounds'][0]['settings']['clients']
cl.append({'id':uuid,'flow':'xtls-rprx-vision','email':email,'level':0})
seen=set()
for x in cl:
    e=x.get('email') or x['id']; base=e; i=1
    while e in seen:
        e=base+'-'+str(i); i+=1
    x['email']=e; seen.add(e)
json.dump(c,open(p,'w'),indent=2)
PY
docker exec amnezia-xray xray -test -config /opt/amnezia/xray/server.json >/dev/null
docker restart amnezia-xray >/dev/null
echo "UUID=$UUID"`;
    return runScript(creds(server.id), script, 120000);
  });
  const uuid = grab(out, 'UUID');
  if (!uuid) throw new Error('Не удалось создать Xray-клиента на сервере.');
  const link =
    `vless://${uuid}@${server.host}:443?type=tcp&security=reality&pbk=${pbk}` +
    `&fp=${REALITY_FP}&sni=${encodeURIComponent(sni)}&sid=${sid}&spx=${encodeURIComponent(REALITY_SPX)}` +
    `&flow=xtls-rprx-vision&encryption=none#NoVPN-${encodeURIComponent(nm)}`;
  return { uuid, link, publicKey: pbk };
}

/** Сменить reality-SNI на сервере БЕЗ переустановки: правим serverNames+dest в
 *  server.json и перезапускаем Xray. Ключи (privateKey/shortIds) не трогаем — уже
 *  выданные UUID остаются валидными, меняется только маскировка. Идемпотентно:
 *  если сервер уже на нужном SNI — НЕ перезаписываем и НЕ рестартуем (безопасно
 *  звать из авто-сверки). Пишем во временный файл, тестируем и только потом
 *  подменяем боевой конфиг. Возвращает true, если реально применили изменение. */
export async function sshSetXraySni(server: Server, sni: string = REALITY_SNI): Promise<boolean> {
  const out = await withServerLock(server.id, () => {
    const script = `set -e
for i in $(seq 1 15); do docker exec amnezia-xray true 2>/dev/null && break; sleep 1; done
python3 - '${sni}' <<'PY'
import json,sys
sni=sys.argv[1]
p='/opt/amnezia/xray/server.json'
c=json.load(open(p))
rs=c['inbounds'][0]['streamSettings']['realitySettings']
if rs.get('serverNames')==[sni] and rs.get('dest')==sni+':443':
    print('ALREADY'); sys.exit(0)
rs['serverNames']=[sni]
rs['dest']=sni+':443'
json.dump(c,open(p+'.tmp','w'),indent=2)
print('WRITTEN')
PY
if [ -f /opt/amnezia/xray/server.json.tmp ]; then
  docker exec amnezia-xray xray -test -config /opt/amnezia/xray/server.json.tmp >/dev/null
  mv /opt/amnezia/xray/server.json.tmp /opt/amnezia/xray/server.json
  docker restart amnezia-xray >/dev/null
  echo SNI_SET
else
  echo SNI_ALREADY
fi`;
    return runScript(creds(server.id), script, 120000);
  });
  if (/SNI_SET/.test(out)) return true;
  if (/SNI_ALREADY/.test(out)) return false;
  throw new Error('Не удалось сменить SNI на сервере: ' + out.slice(-200));
}

export async function sshCreateAwg(
  server: Server,
  deviceName: string,
): Promise<{ conf: string; publicKey: string; privateKey: string; presharedKey: string; clientIp: string }> {
  const keys = getServerKeys(server.host);
  const srvPub = keys?.awgServerPubKey;
  if (!srvPub) throw new Error('В панели нет AmneziaWG-ключа этого сервера. Переустановите/зарегистрируйте сервер.');
  const nm = san(deviceName);
  const script = `set -e
CONF=/etc/amnezia/amneziawg/awg0.conf
CPRIV=$(awg genkey); CPUB=$(printf '%s' "$CPRIV" | awg pubkey); PSK=$(awg genpsk)
USED=$(grep -oE 'AllowedIPs = 10\\.8\\.1\\.[0-9]+' "$CONF" | grep -oE '[0-9]+$' || true)
N=2; while echo "$USED" | grep -qx "$N"; do N=$((N+1)); done
CIP=10.8.1.$N
printf '%s' "$PSK" | awg set awg0 peer "$CPUB" preshared-key /dev/stdin allowed-ips \${CIP}/32
printf '\\n[Peer]\\n# ${nm}\\nPublicKey = %s\\nPresharedKey = %s\\nAllowedIPs = %s/32\\n' "$CPUB" "$PSK" "$CIP" >> "$CONF"
p(){ awk -F'= ' -v k="$1" 'index($0,k" ")==1{print $2; exit}' "$CONF"; }
echo "CPRIV=$CPRIV"; echo "CPUB=$CPUB"; echo "PSK=$PSK"; echo "CIP=$CIP"
echo "Jc=$(p Jc)"; echo "Jmin=$(p Jmin)"; echo "Jmax=$(p Jmax)"; echo "S1=$(p S1)"; echo "S2=$(p S2)"
echo "H1=$(p H1)"; echo "H2=$(p H2)"; echo "H3=$(p H3)"; echo "H4=$(p H4)"`;
  const out = await withServerLock(server.id, () => runScript(creds(server.id), script, 60000));
  const cpriv = grab(out, 'CPRIV');
  const cpub = grab(out, 'CPUB');
  const psk = grab(out, 'PSK');
  const cip = grab(out, 'CIP');
  if (!cpriv || !cpub || !psk || !cip) throw new Error('Не удалось создать AmneziaWG-пира на сервере.');

  // Параметры обфускации ОБЯЗАНЫ совпадать с серверными: они уникальны для
  // каждого сервера. Раньше при сбое парсинга сюда молча подставлялись
  // захардкоженные значения — конфиг выглядел рабочим, но не подключался.
  // Лучше честная ошибка, чем «выдал, а оно не работает».
  const obf: Record<string, string> = {};
  for (const k of ['Jc', 'Jmin', 'Jmax', 'S1', 'S2', 'H1', 'H2', 'H3', 'H4']) {
    const v = grab(out, k);
    if (!v) throw new Error(`Не удалось прочитать параметр обфускации ${k} с сервера — конфиг не выдан, чтобы не отдать неработающий. Проверьте awg0.conf на сервере.`);
    obf[k] = v;
  }

  const conf = `[Interface]
PrivateKey = ${cpriv}
Address = ${cip}/32
DNS = 1.1.1.1
Jc = ${obf.Jc}
Jmin = ${obf.Jmin}
Jmax = ${obf.Jmax}
S1 = ${obf.S1}
S2 = ${obf.S2}
H1 = ${obf.H1}
H2 = ${obf.H2}
H3 = ${obf.H3}
H4 = ${obf.H4}

[Peer]
PublicKey = ${srvPub}
PresharedKey = ${psk}
Endpoint = ${server.host}:51820
AllowedIPs = 0.0.0.0/0, ::/0
PersistentKeepalive = 25`;
  return { conf, publicKey: cpub, privateKey: cpriv, presharedKey: psk, clientIp: cip };
}

// Установка прокси-комплекта (HTTP/SOCKS5 через 3proxy на хосте; HTTPS через
// certbot+stunnel поверх HTTP-прокси). Идемпотентно, переиспользует логин/пароль.
export async function sshInstallProxies(
  server: Server,
  opts: { http?: boolean; https?: boolean; socks?: boolean },
): Promise<{ user: string; pass: string; httpPort: number | null; httpsPort: number | null; socksPort: number | null; httpsHost: string | null }> {
  const domain = server.host;
  // host задаёт админ — прежде чем подставлять в install-скрипт (DOMAIN=…, certbot -d),
  // проверяем, что это валидный хост (буквы/цифры/дефис/точки), а не shell-инъекция.
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(domain)) throw new Error('Некорректный хост сервера.');
  const wantHttps = !!opts.https;
  // HTTP-прокси нужен и сам по себе, и как бэкенд для HTTPS(stunnel).
  const wantHttp = !!opts.http || wantHttps;
  const wantSocks = !!opts.socks;
  const script = `set -e
export DEBIAN_FRONTEND=noninteractive
HTTP_PORT=8080; SOCKS_PORT=1080; HTTPS_PORT=8443; DOMAIN=${domain}
# Сохраняем ВСЕ существующие логины (novpn + выданные пользователям), иначе
# переустановка прокси сотрёт per-user учётки из конфига.
USERSLINE=$(grep -h '^users ' /etc/3proxy/3proxy.cfg 2>/dev/null | sed 's/^users //' | tr '\\n' ' ')
USERSLINE=$(echo $USERSLINE)
PUSER=$(echo "$USERSLINE" | awk '{print $1}' | cut -d: -f1)
PPASS=$(echo "$USERSLINE" | awk '{print $1}' | sed 's/^[^:]*:CL://')
PUSER=\${PUSER:-novpn}
PPASS=\${PPASS:-$(head -c 12 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 16)}
if [ -z "$USERSLINE" ]; then USERSLINE="$PUSER:CL:$PPASS"; fi
# allow — логины через ЗАПЯТУЮ (в allow пробел разделяет поля users/источник/цель,
# иначе 3proxy читает второй логин как IP и падает «Invalid IP … line»).
ALLOWU=$(echo "$USERSLINE" | tr ' ' '\\n' | cut -d: -f1 | paste -sd, -)

# --- 3proxy (http + socks) ---
if [ ! -x /usr/local/bin/3proxy ]; then
  cd /opt; rm -rf 3proxy-src
  git clone --depth 1 https://github.com/3proxy/3proxy 3proxy-src >/dev/null 2>&1
  cd 3proxy-src; ln -sf Makefile.Linux Makefile; make -j2 >/tmp/3p.log 2>&1
  BIN=$(find . -name 3proxy -type f -perm -u+x | head -1); install -m0755 "$BIN" /usr/local/bin/3proxy
fi
mkdir -p /etc/3proxy /var/log/3proxy
{
  echo "nscache 65536"; echo "nserver 1.1.1.1"; echo "nserver 8.8.8.8"
  echo "timeouts 1 5 30 60 180 1800 15 60"
  # Учёт трафика по пользователям: строка на закрытие соединения. D — суточная
  # ротация (счётчик файлов у 3proxy — отдельная директива, в аргумент log его
  # класть нельзя). Формат: время логин байты_вх байты_исх.
  echo "log /var/log/3proxy/3p.log D"; echo 'logformat "L%t %U %I %O"'
  echo "users $USERSLINE"; echo "auth strong"; echo "allow $ALLOWU"
  ${wantHttp ? 'echo "proxy -n -a -p$HTTP_PORT -i0.0.0.0 -e0.0.0.0"' : 'true'}
  ${wantSocks ? 'echo "socks -p$SOCKS_PORT -i0.0.0.0 -e0.0.0.0"' : 'true'}
} > /etc/3proxy/3proxy.cfg
chmod 600 /etc/3proxy/3proxy.cfg
cat > /etc/systemd/system/3proxy.service <<'SVC'
[Unit]
Description=3proxy (NoVPN)
After=network.target
[Service]
ExecStart=/usr/local/bin/3proxy /etc/3proxy/3proxy.cfg
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
SVC
systemctl daemon-reload; systemctl enable 3proxy >/dev/null 2>&1 || true; systemctl restart 3proxy
# Открыть порты прокси в файрволе — иначе снаружи недоступны, хотя локально
# работают. ufw (если активен, персистентно) + iptables (немедленно).
openp(){ if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qiw active; then ufw allow "$1"/tcp >/dev/null 2>&1 || true; fi; iptables -C INPUT -p tcp --dport "$1" -j ACCEPT 2>/dev/null || iptables -I INPUT -p tcp --dport "$1" -j ACCEPT 2>/dev/null || true; }
${wantHttp ? 'openp $HTTP_PORT' : 'true'}
${wantSocks ? 'openp $SOCKS_PORT' : 'true'}
${wantHttps ? 'openp $HTTPS_PORT' : 'true'}
${
  wantHttps
    ? `
# --- HTTPS через certbot + stunnel ---
apt-get install -y -qq certbot stunnel4 >/tmp/apt.log 2>&1
if [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
  certbot certonly --standalone --non-interactive --agree-tos --register-unsafely-without-email -d "$DOMAIN" >/tmp/cb.log 2>&1
fi
mkdir -p /etc/stunnel
printf 'pid = /run/stunnel-novpn.pid\\n[https-proxy]\\naccept = 0.0.0.0:%s\\nconnect = 127.0.0.1:%s\\ncert = /etc/letsencrypt/live/%s/fullchain.pem\\nkey = /etc/letsencrypt/live/%s/privkey.pem\\n' "$HTTPS_PORT" "$HTTP_PORT" "$DOMAIN" "$DOMAIN" > /etc/stunnel/novpn.conf
cat > /etc/systemd/system/novpn-stunnel.service <<'SVC2'
[Unit]
Description=NoVPN stunnel (HTTPS proxy)
After=network.target 3proxy.service
[Service]
ExecStart=/usr/bin/stunnel /etc/stunnel/novpn.conf
Type=forking
PIDFile=/run/stunnel-novpn.pid
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
SVC2
systemctl daemon-reload; systemctl enable novpn-stunnel >/dev/null 2>&1 || true; systemctl restart novpn-stunnel
`
    : 'true'
}
echo "PUSER=$PUSER"; echo "PPASS=$PPASS"
echo "HTTP_PORT=${wantHttp ? '$HTTP_PORT' : ''}"
echo "SOCKS_PORT=${wantSocks ? '$SOCKS_PORT' : ''}"
echo "HTTPS_PORT=${wantHttps ? '$HTTPS_PORT' : ''}"`;
  // Сборка 3proxy + apt/certbot могут занять несколько минут.
  const out = await runScript(creds(server.id), script, 420000);
  const user = grab(out, 'PUSER');
  const pass = grab(out, 'PPASS');
  if (!user || !pass) throw new Error('Не удалось установить прокси на сервере.');
  const num = (k: string) => {
    const v = grab(out, k);
    return v ? Number(v) : null;
  };
  return { user, pass, httpPort: num('HTTP_PORT'), socksPort: num('SOCKS_PORT'), httpsPort: num('HTTPS_PORT'), httpsHost: wantHttps ? domain : null };
}

// Сбор статистики AmneziaWG: rx/tx и время последнего рукопожатия по каждому пиру.
export async function sshSyncAwg(
  serverId: string,
): Promise<Array<{ publicKey: string; handshake: number; rx: number; tx: number }>> {
  const out = await runScript(creds(serverId), `awg show awg0 dump | awk 'NR>1{print $1" "$5" "$6" "$7}'`);
  const peers: Array<{ publicKey: string; handshake: number; rx: number; tx: number }> = [];
  for (const line of out.split('\n')) {
    const p = line.trim().split(/\s+/);
    if (p.length >= 4 && p[0] && p[0].length > 20) {
      peers.push({ publicKey: p[0], handshake: Number(p[1]) || 0, rx: Number(p[2]) || 0, tx: Number(p[3]) || 0 });
    }
  }
  return peers;
}

/** Собрать статистику Xray по клиентам с прошлого замера.
 *  Требует включённого stats API (api-inbound 127.0.0.1:10085 + policy level 0).
 *  statsquery --reset возвращает трафик С МОМЕНТА ПРОШЛОГО ЗАМЕРА и обнуляет
 *  счётчик — панель сама копит накопленное (устойчиво к рестарту контейнера,
 *  который обнуляет in-memory статистику Xray). Связка email→uuid берётся из
 *  server.json, поэтому работает и для старых, уже выданных конфигов.
 *  Если stats API не включён — вернёт пустой список (не ошибка). */
export async function sshSyncXray(
  serverId: string,
): Promise<Array<{ uuid: string; up: number; down: number }>> {
  // Карту email→uuid отдаём JSON-ом: email может содержать пробелы (legacy /
  // 3x-ui клиенты) — split по пробелам такие ломает.
  const script = `set -e
echo '---MAP---'
python3 -c "import json,sys;c=json.load(open('/opt/amnezia/xray/server.json'));json.dump([[(x.get('email') or x['id']),x['id']] for x in c['inbounds'][0]['settings']['clients']],sys.stdout)" 2>/dev/null || true
echo
echo '---STATS---'
docker exec amnezia-xray xray api statsquery --server=127.0.0.1:10085 --reset 2>/dev/null || true`;
  const out = await runScript(creds(serverId), script, 30000);
  const mapPart = out.split('---MAP---')[1]?.split('---STATS---')[0] ?? '';
  const statPart = out.split('---STATS---')[1] ?? '';
  const emailToUuid = new Map<string, string>();
  try {
    for (const pair of JSON.parse(mapPart.trim() || '[]') as Array<[string, string]>) {
      if (pair?.[0] && pair?.[1]) emailToUuid.set(pair[0], pair[1]);
    }
  } catch {
    /* нет server.json / битый JSON — вернём пусто */
  }
  const up = new Map<string, number>();
  const down = new Map<string, number>();
  try {
    // statsquery отдаёт { "stat": [ {"name":"user>>>email>>>traffic>>>uplink","value":"123"} ] }.
    const j = JSON.parse(statPart.trim() || '{}');
    for (const s of (j.stat ?? []) as Array<{ name?: string; value?: string }>) {
      const m = String(s.name ?? '').match(/^user>>>(.+?)>>>traffic>>>(uplink|downlink)$/);
      if (!m) continue;
      const v = Number(s.value ?? 0) || 0;
      if (m[2] === 'uplink') up.set(m[1]!, v);
      else down.set(m[1]!, v);
    }
  } catch {
    /* нет статистики / неполный JSON — вернём то, что смогли (обычно пусто) */
  }
  const res: Array<{ uuid: string; up: number; down: number }> = [];
  for (const [email, uuid] of emailToUuid) {
    res.push({ uuid, up: up.get(email) ?? 0, down: down.get(email) ?? 0 });
  }
  return res;
}

/** Собрать трафик прокси по логинам из логов 3proxy (свежий суточный файл).
 *  Возвращает суммарные байты за текущий день на логин; накопление и обработку
 *  суточного сброса делает вызывающий (как у AWG). Пусто, если логов нет. */
export async function sshReadProxyTraffic(serverId: string): Promise<Array<{ login: string; bytes: number }>> {
  // Чистим логи старше 14 дней (3proxy с суточной ротацией без счётчика копит
  // файлы), затем берём самый свежий файл (= сегодняшний) и суммируем %I+%O.
  const cmd = `find /var/log/3proxy -name '3p.log.*' -mtime +14 -delete 2>/dev/null; f=$(ls -t /var/log/3proxy/3p.log.* 2>/dev/null | head -1); [ -n "$f" ] && awk '$2!="-"{t[$2]+=$3+$4} END{for(u in t)print u" "t[u]}' "$f" || true`;
  const out = await runScript(creds(serverId), cmd, 30000);
  const res: Array<{ login: string; bytes: number }> = [];
  for (const line of out.split('\n')) {
    const p = line.trim().split(/\s+/);
    if (p.length >= 2 && p[0]) res.push({ login: p[0], bytes: Number(p[1]) || 0 });
  }
  return res;
}

/** Лёгкая проверка живости сервера по SSH (для серверов без AWG-статистики).
 *  Бросает, если сервер не ответил. */
export async function sshPing(serverId: string): Promise<void> {
  await runScript(creds(serverId), 'echo ok', 15000);
}

export async function sshRevokeXray(server: Server, uuid: string): Promise<void> {
  assertUuid(uuid); // защита от инъекции в python -c (значение может быть из импорта)
  const script = `set -e
python3 -c "import json;p='/opt/amnezia/xray/server.json';c=json.load(open(p));c['inbounds'][0]['settings']['clients']=[x for x in c['inbounds'][0]['settings']['clients'] if x.get('id')!='${uuid}'];json.dump(c,open(p,'w'),indent=2)"
docker restart amnezia-xray >/dev/null
echo OK`;
  await withServerLock(server.id, () => runScript(creds(server.id), script, 60000));
}

export async function sshRevokeAwg(server: Server, publicKey: string): Promise<void> {
  assertWgKey(publicKey); // защита от инъекции в awg set / python (значение может быть из импорта)
  const script = `set -e
awg set awg0 peer "${publicKey}" remove || true
PUB="${publicKey}" python3 -c "import os,re;p='/etc/amnezia/amneziawg/awg0.conf';t=open(p).read();pub=re.escape(os.environ['PUB']);t=re.sub(r'\\n\\[Peer\\][^\\[]*?PublicKey = '+pub+r'[^\\[]*','\\n',t);open(p,'w').write(t)"
echo OK`;
  await withServerLock(server.id, () => runScript(creds(server.id), script, 60000));
}

// Пересборка /etc/3proxy/3proxy.cfg (python, запускается на сервере): читает
// существующий конфиг, добавляет/убирает логин, НЕ затирая остальных, и пишет
// заголовок → users (через ПРОБЕЛ) → auth/allow (логины через ЗАПЯТУЮ!) →
// сервисные строки. Экспортируется, чтобы регресс-тест гонял ровно этот код.
// КРИТИЧНО: в allow пробел разделяет ПОЛЯ (users/источник/цель) — пробел между
// логинами 3proxy читает как IP-источник и падает «Invalid IP … line».
export const PROXY_REBUILD_PY = `import sys
mode,login,passwd=sys.argv[1],sys.argv[2],sys.argv[3]
p=sys.argv[4] if len(sys.argv)>4 else '/etc/3proxy/3proxy.cfg'
try:
    lines=open(p).read().splitlines()
except FileNotFoundError:
    print('NOCFG'); sys.exit(1)
users={}; services=[]; header=[]
for ln in lines:
    s=ln.strip()
    if not s: continue
    if s.startswith('users '):
        for tok in s[6:].split():
            if ':CL:' in tok:
                u,pw=tok.split(':CL:',1); users[u]=pw
    elif s.startswith('proxy') or s.startswith('socks'):
        services.append(s)
    elif s.startswith('auth') or s.startswith('allow') or s.startswith('deny'):
        pass
    else:
        header.append(s)
if mode=='add': users[login]=passwd
elif mode=='remove': users.pop(login,None)
if not any(h.startswith('log ') for h in header):
    header.append('log /var/log/3proxy/3p.log D')
    header.append('logformat "L%t %U %I %O"')
out=list(header)
if users:
    out.append('users '+' '.join('%s:CL:%s'%(u,pw) for u,pw in users.items()))
    out.append('auth strong')
    out.append('allow '+','.join(users.keys()))
else:
    out.append('auth none')
out+=services
open(p,'w').write('\\n'.join(out)+'\\n')
print('OK users=%d'%len(users))`;

// Добавить/удалить пользователя 3proxy, НЕ затирая остальных.
function buildProxyUserScript(mode: 'add' | 'remove', login: string, pass: string): string {
  const py = PROXY_REBUILD_PY;
  return `set -e
mkdir -p /var/log/3proxy
python3 - '${mode}' '${login}' '${pass}' <<'PY'
${py}
PY
chmod 600 /etc/3proxy/3proxy.cfg
systemctl restart 3proxy
# Открыть порты прокси в файрволе (иначе снаружи недоступны, хотя локально работают).
openp(){ if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qiw active; then ufw allow "$1"/tcp >/dev/null 2>&1 || true; fi; iptables -C INPUT -p tcp --dport "$1" -j ACCEPT 2>/dev/null || iptables -I INPUT -p tcp --dport "$1" -j ACCEPT 2>/dev/null || true; }
openp 8080; openp 1080; openp 8443
echo PROXY_USER_OK`;
}

export async function sshAddProxyUser(server: Server, login: string, pass: string): Promise<void> {
  const out = await withServerLock(server.id, () => runScript(creds(server.id), buildProxyUserScript('add', login, pass), 60000));
  if (/NOCFG/.test(out)) throw new Error('На сервере не установлены прокси — сначала установите их в настройках сервера.');
  if (!/PROXY_USER_OK/.test(out)) throw new Error('Не удалось добавить прокси-логин на сервере.');
}

export async function sshRevokeProxyUser(server: Server, login: string): Promise<void> {
  await withServerLock(server.id, () => runScript(creds(server.id), buildProxyUserScript('remove', login, ''), 60000));
}
