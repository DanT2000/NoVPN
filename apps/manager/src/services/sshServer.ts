// Выпуск/отзыв конфигов на VPN-сервере ПО SSH (manager → сервер).
// Лёгкий путь без агента на самом VPS (важно для сервера с 1GB RAM):
// panel по SSH выполняет те же команды (xray через docker exec, awg через awg set).

import { Client } from 'ssh2';
import type { Server } from '@novpn/shared';
import { decryptSecret } from '../lib/crypto.js';
import { getServerSsh } from '../repo.js';
import { getServerKeys } from './keyvault.js';

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

// ── Провижининг сервера с нуля (xray Reality + AmneziaWG) ──
// Скрипт без bash-${…} (кроме инжектов сверху) — безопасно в JS-шаблоне.
// Параметры обфускации AWG фиксированы → восстановление по домену требует только приватный ключ.
function buildInstallScript(o: {
  sni: string; realityPriv: string; shortId: string; awgPriv: string; xray: boolean; awg: boolean;
}): string {
  const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  return `set -e
SNI=${q(o.sni)}
REALITY_PRIV=${q(o.realityPriv)}
SHORT_ID=${q(o.shortId)}
AWG_PRIV=${q(o.awgPriv)}
WANT_XRAY=${o.xray ? '1' : '0'}
WANT_AWG=${o.awg ? '1' : '0'}
IFACE="$(ip route get 8.8.8.8 2>/dev/null | grep -oP 'dev \\K\\S+' | head -1)"
[ -z "$IFACE" ] && IFACE=eth0
JC=4; JMIN=40; JMAX=70; S1=86; S2=97
H1=1004746675; H2=928473625; H3=1719083348; H4=1339303396

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
 "inbounds":[{"listen":"0.0.0.0","port":443,"protocol":"vless","tag":"vless-reality",
   "settings":{"clients":[],"decryption":"none"},
   "streamSettings":{"network":"tcp","security":"reality",
     "realitySettings":{"show":False,"dest":sni+":443","xver":0,
       "serverNames":[sni],"privateKey":priv,"shortIds":[sid]}},
   "sniffing":{"enabled":True,"destOverride":["http","tls","quic"]}}],
 "outbounds":[{"protocol":"freedom","tag":"direct"}]}
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

function buildUninstallScript(): string {
  return `set +e
docker rm -f amnezia-xray 2>/dev/null
awg-quick down awg0 2>/dev/null
systemctl disable --now awg-quick@awg0 2>/dev/null
apt-get purge -y amneziawg amneziawg-tools amneziawg-dkms >/dev/null 2>&1
rm -rf /etc/amnezia /opt/amnezia
systemctl disable --now 3proxy 2>/dev/null
systemctl disable --now novpn-stunnel 2>/dev/null
rm -f /usr/local/bin/3proxy /etc/systemd/system/3proxy.service /etc/systemd/system/novpn-stunnel.service
rm -rf /etc/3proxy /etc/stunnel/novpn.conf /opt/3proxy-src /etc/letsencrypt
systemctl daemon-reload 2>/dev/null
echo UNINSTALL_DONE`;
}

/** Установить VPN-комплект (xray/awg). Если переданы ключи — восстановление по домену. */
export async function sshInstallServer(
  server: Server,
  opts: { xray: boolean; awg: boolean; sni?: string; realityPriv?: string; shortId?: string; awgPriv?: string },
): Promise<{ realityPriv?: string; realityPub?: string; shortId?: string; sni?: string; awgPriv?: string; awgPub?: string }> {
  const script = buildInstallScript({
    sni: opts.sni || 'vk.com',
    realityPriv: opts.realityPriv || '',
    shortId: opts.shortId || '',
    awgPriv: opts.awgPriv || '',
    xray: opts.xray,
    awg: opts.awg,
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
  const xray = items.filter((i) => i.protocol === 'xray' && i.uuid).map((i) => ({ id: i.uuid, name: san(i.name) }));
  const awg = items.filter((i) => i.protocol === 'amneziawg' && i.awgPub && i.clientIp);
  const lines: string[] = ['set +e'];
  if (xray.length) {
    const json = JSON.stringify(xray).replace(/'/g, "'\\''");
    lines.push(
      `python3 -c "import json;p='/opt/amnezia/xray/server.json';c=json.load(open(p));ex={x['id'] for x in c['inbounds'][0]['settings']['clients']};` +
        `[c['inbounds'][0]['settings']['clients'].append({'id':d['id'],'flow':'xtls-rprx-vision','email':d['name']}) for d in json.loads('${json}') if d['id'] not in ex];` +
        `json.dump(c,open(p,'w'),indent=2)"`,
      'docker restart amnezia-xray >/dev/null 2>&1 || true',
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

export async function sshCreateXray(server: Server, deviceName: string): Promise<{ uuid: string; link: string; publicKey: string }> {
  const keys = getServerKeys(server.host);
  const pbk = keys?.xrayRealityPubKey;
  const sid = keys?.xrayShortId;
  const sni = keys?.xraySni;
  if (!pbk || !sid || !sni) throw new Error('В панели нет reality-ключей этого сервера. Переустановите/зарегистрируйте сервер.');
  const nm = san(deviceName);
  const script = `set -e
UUID=$(docker exec amnezia-xray xray uuid)
python3 -c "import json;p='/opt/amnezia/xray/server.json';c=json.load(open(p));c['inbounds'][0]['settings']['clients'].append({'id':'$UUID','flow':'xtls-rprx-vision','email':'${nm}'});json.dump(c,open(p,'w'),indent=2)"
docker exec amnezia-xray xray -test -config /opt/amnezia/xray/server.json >/dev/null
docker restart amnezia-xray >/dev/null
echo "UUID=$UUID"`;
  const out = await runScript(creds(server.id), script);
  const uuid = grab(out, 'UUID');
  if (!uuid) throw new Error('Не удалось создать Xray-клиента на сервере.');
  const link =
    `vless://${uuid}@${server.host}:443?type=tcp&security=reality&pbk=${pbk}` +
    `&fp=chrome&sni=${encodeURIComponent(sni)}&sid=${sid}&flow=xtls-rprx-vision&encryption=none#NoVPN-${encodeURIComponent(nm)}`;
  return { uuid, link, publicKey: pbk };
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
USED=$(grep -oE 'AllowedIPs = 10\\.8\\.1\\.[0-9]+' "$CONF" | grep -oE '[0-9]+$')
N=2; while echo "$USED" | grep -qx "$N"; do N=$((N+1)); done
CIP=10.8.1.$N
printf '%s' "$PSK" | awg set awg0 peer "$CPUB" preshared-key /dev/stdin allowed-ips \${CIP}/32
printf '\\n[Peer]\\n# ${nm}\\nPublicKey = %s\\nPresharedKey = %s\\nAllowedIPs = %s/32\\n' "$CPUB" "$PSK" "$CIP" >> "$CONF"
p(){ awk -F'= ' -v k="$1" 'index($0,k" ")==1{print $2; exit}' "$CONF"; }
echo "CPRIV=$CPRIV"; echo "CPUB=$CPUB"; echo "PSK=$PSK"; echo "CIP=$CIP"
echo "Jc=$(p Jc)"; echo "Jmin=$(p Jmin)"; echo "Jmax=$(p Jmax)"; echo "S1=$(p S1)"; echo "S2=$(p S2)"
echo "H1=$(p H1)"; echo "H2=$(p H2)"; echo "H3=$(p H3)"; echo "H4=$(p H4)"`;
  const out = await runScript(creds(server.id), script);
  const cpriv = grab(out, 'CPRIV');
  const cpub = grab(out, 'CPUB');
  const psk = grab(out, 'PSK');
  const cip = grab(out, 'CIP');
  if (!cpriv || !cpub || !psk || !cip) throw new Error('Не удалось создать AmneziaWG-пира на сервере.');
  const conf = `[Interface]
PrivateKey = ${cpriv}
Address = ${cip}/32
DNS = 1.1.1.1
Jc = ${grab(out, 'Jc') ?? 4}
Jmin = ${grab(out, 'Jmin') ?? 40}
Jmax = ${grab(out, 'Jmax') ?? 70}
S1 = ${grab(out, 'S1') ?? 86}
S2 = ${grab(out, 'S2') ?? 97}
H1 = ${grab(out, 'H1') ?? 1004746675}
H2 = ${grab(out, 'H2') ?? 928473625}
H3 = ${grab(out, 'H3') ?? 1719083348}
H4 = ${grab(out, 'H4') ?? 1339303396}

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
  const wantHttps = !!opts.https;
  // HTTP-прокси нужен и сам по себе, и как бэкенд для HTTPS(stunnel).
  const wantHttp = !!opts.http || wantHttps;
  const wantSocks = !!opts.socks;
  const script = `set -e
export DEBIAN_FRONTEND=noninteractive
HTTP_PORT=8080; SOCKS_PORT=1080; HTTPS_PORT=8443; DOMAIN=${domain}
PUSER=novpn
if [ -f /etc/3proxy/3proxy.cfg ]; then
  L=$(grep -m1 '^users ' /etc/3proxy/3proxy.cfg | sed 's/^users //')
  PUSER=\${L%%:CL:*}; PPASS=\${L##*:CL:}
fi
PPASS=\${PPASS:-$(head -c 12 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 16)}

# --- 3proxy (http + socks) ---
if [ ! -x /usr/local/bin/3proxy ]; then
  cd /opt; rm -rf 3proxy-src
  git clone --depth 1 https://github.com/3proxy/3proxy 3proxy-src >/dev/null 2>&1
  cd 3proxy-src; ln -sf Makefile.Linux Makefile; make -j2 >/tmp/3p.log 2>&1
  BIN=$(find . -name 3proxy -type f -perm -u+x | head -1); install -m0755 "$BIN" /usr/local/bin/3proxy
fi
mkdir -p /etc/3proxy
{
  echo "nscache 65536"; echo "nserver 1.1.1.1"; echo "nserver 8.8.8.8"
  echo "timeouts 1 5 30 60 180 1800 15 60"
  echo "users $PUSER:CL:$PPASS"; echo "auth strong"; echo "allow $PUSER"
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

export async function sshRevokeXray(server: Server, uuid: string): Promise<void> {
  const script = `set -e
python3 -c "import json;p='/opt/amnezia/xray/server.json';c=json.load(open(p));c['inbounds'][0]['settings']['clients']=[x for x in c['inbounds'][0]['settings']['clients'] if x.get('id')!='${uuid}'];json.dump(c,open(p,'w'),indent=2)"
docker restart amnezia-xray >/dev/null
echo OK`;
  await runScript(creds(server.id), script);
}

export async function sshRevokeAwg(server: Server, publicKey: string): Promise<void> {
  const script = `set -e
awg set awg0 peer "${publicKey}" remove || true
PUB="${publicKey}" python3 -c "import os,re;p='/etc/amnezia/amneziawg/awg0.conf';t=open(p).read();pub=re.escape(os.environ['PUB']);t=re.sub(r'\\n\\[Peer\\][^\\[]*?PublicKey = '+pub+r'[^\\[]*','\\n',t);open(p,'w').write(t)"
echo OK`;
  await runScript(creds(server.id), script);
}
