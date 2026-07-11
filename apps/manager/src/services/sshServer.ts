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
