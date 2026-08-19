// Регресс на фикс мобильного «блэкхола» AmneziaWG: MTU=1280 должен доезжать до
// vpn://-ссылки приложения (единый источник — сам .conf), а при отсутствии MTU в
// конфиге ссылка берёт безопасный дефолт 1280.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vpnLinkFromConf, parseAmneziaVpnLink } from '../src/services/amneziaLink.js';

function confWith(mtuLine: string): string {
  return `[Interface]
PrivateKey = aabbccddeeff00112233445566778899aabbccddeeff0011=
Address = 10.8.1.5/32
DNS = 1.1.1.1
${mtuLine}Jc = 4
Jmin = 20
Jmax = 68
S1 = 34
S2 = 23
H1 = 869845836
H2 = 1785917056
H3 = 81756093
H4 = 1953870091

[Peer]
PublicKey = YvK9NqO2pgUO/SySYfYseV7aqHbcNxJ15EAiizax8XI=
PresharedKey = ZZZZNqO2pgUO/SySYfYseV7aqHbcNxJ15EAiizax8XI=
Endpoint = host.example:57512
AllowedIPs = 0.0.0.0/0, ::/0
PersistentKeepalive = 25`;
}

test('vpn://-ссылка несёт MTU=1280 из конфига', () => {
  const link = vpnLinkFromConf(confWith('MTU = 1280\n'), 'Test')!;
  assert.ok(link.startsWith('vpn://'));
  const payload = parseAmneziaVpnLink(link);
  const last = JSON.parse(payload.containers[0].awg.last_config);
  assert.equal(last.mtu, '1280');
  assert.match(last.config, /MTU = 1280/);
});

test('без строки MTU в конфиге ссылка берёт безопасный дефолт 1280', () => {
  const link = vpnLinkFromConf(confWith(''), 'Test')!;
  const payload = parseAmneziaVpnLink(link);
  const last = JSON.parse(payload.containers[0].awg.last_config);
  assert.equal(last.mtu, '1280');
});
