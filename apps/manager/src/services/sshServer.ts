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
  return { host: s.host, port: s.port, username: s.user, password: decryptSecret(s.passwordEnc) };
}

function runScript(c: { host: string; port: number; username: string; password: string }, script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      conn.end();
      reject(new Error('SSH: таймаут'));
    }, 30000);
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
    conn.connect({ host: c.host, port: c.port, username: c.username, password: c.password, readyTimeout: 15000 });
  });
}

const san = (n: string) => (n.replace(/[^\w .-]/g, '').trim().slice(0, 40) || 'device');
const grab = (out: string, k: string) => out.match(new RegExp('^' + k + '=(.+)$', 'm'))?.[1]?.trim();

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
  const out = await runScript(creds(server.id), script);
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
