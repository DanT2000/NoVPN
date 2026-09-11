// Разбор чужих подписок для резервной маршрутизации: base64/открытый список
// vless/vmess/trojan/ss, Clash-YAML эвристикой, и заголовок Subscription-Userinfo.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseSubscription, parseSubUserinfo } = await import('../src/lib/subParse.js');

const vless = 'vless://11111111-2222-3333-4444-555555555555@nl1.example.com:443?type=tcp&security=reality&sni=cdn.example.net#%F0%9F%87%B3%F0%9F%87%B1%20Netherlands%201';
const trojan = 'trojan://secretpass@fr.example.com:8443?sni=fr.example.com#France';
const vmessJson = { v: '2', ps: 'Germany', add: 'de.example.com', port: '2053', id: 'aaaa', net: 'ws', tls: 'tls' };
const vmess = 'vmess://' + Buffer.from(JSON.stringify(vmessJson)).toString('base64');
const ss = 'ss://' + Buffer.from('aes-256-gcm:password123').toString('base64') + '@ss.example.com:8388#Shadow';

test('открытый список: vless/trojan/vmess/ss', () => {
  const body = [vless, trojan, vmess, ss].join('\n');
  const r = parseSubscription(body);
  assert.equal(r.format, 'plain');
  assert.equal(r.nodes.length, 4);
  const nl = r.nodes[0];
  assert.equal(nl.protocol, 'vless');
  assert.equal(nl.host, 'nl1.example.com');
  assert.equal(nl.port, 443);
  assert.equal(nl.name, '🇳🇱 Netherlands 1'); // #фрагмент percent-decoded
  const de = r.nodes.find((n) => n.protocol === 'vmess');
  assert.equal(de?.host, 'de.example.com');
  assert.equal(de?.port, 2053);
  assert.equal(de?.name, 'Germany');
  const sh = r.nodes.find((n) => n.protocol === 'ss');
  assert.equal(sh?.host, 'ss.example.com');
  assert.equal(sh?.port, 8388);
});

test('base64 от списка распознаётся и раскодируется', () => {
  const body = Buffer.from([vless, trojan].join('\n')).toString('base64');
  const r = parseSubscription(body);
  assert.equal(r.format, 'base64');
  assert.equal(r.nodes.length, 2);
  assert.equal(r.nodes[0].host, 'nl1.example.com');
});

test('дедуп по protocol|host|port', () => {
  const r = parseSubscription([vless, vless].join('\n'));
  assert.equal(r.nodes.length, 1);
});

test('пустое и мусор не роняют парсер', () => {
  assert.equal(parseSubscription('').nodes.length, 0);
  assert.equal(parseSubscription('   \n  \n').nodes.length, 0);
  assert.equal(parseSubscription('hello world not a sub').nodes.length, 0);
});

test('Clash-YAML: эвристика тянет server/port/name', () => {
  const yaml = [
    'port: 7890',
    'proxies:',
    '  - {name: "NL Reality", server: nl.clash.example, port: 443, type: vless}',
    '  - name: FR',
    '    server: fr.clash.example',
    '    port: 8443',
    '    type: trojan',
    'proxy-groups:',
    '  - {name: auto, type: url-test}',
  ].join('\n');
  const r = parseSubscription(yaml);
  assert.equal(r.format, 'clash');
  assert.ok(r.nodes.length >= 2);
  const nl = r.nodes.find((n) => n.host === 'nl.clash.example');
  assert.equal(nl?.port, 443);
  assert.equal(nl?.protocol, 'vless');
  const fr = r.nodes.find((n) => n.host === 'fr.clash.example');
  assert.equal(fr?.port, 8443);
});

test('Xray-JSON (массив конфигов v2rayN) разбирается в ссылки', () => {
  const configs = [
    {
      remarks: '🇳🇱 Reality',
      outbounds: [
        {
          protocol: 'vless',
          settings: { vnext: [{ address: '188.130.209.185', port: 443, users: [{ id: 'uuid-1', flow: 'xtls-rprx-vision', encryption: 'none' }] }] },
          streamSettings: { network: 'tcp', security: 'reality', realitySettings: { serverName: 'cdn.example', fingerprint: 'qq', publicKey: 'PBK', shortId: 'SID', spiderX: '/' } },
        },
        { protocol: 'freedom', tag: 'direct' },
      ],
    },
    {
      remarks: 'WS TLS',
      outbounds: [
        {
          protocol: 'vless',
          settings: { vnext: [{ address: 'ws.example.ru', port: 443, users: [{ id: 'uuid-2', encryption: 'none' }] }] },
          streamSettings: { network: 'ws', security: 'tls', tlsSettings: { serverName: 'ws.example.ru' }, wsSettings: { path: '/chws', headers: { Host: 'ws.example.ru' } } },
        },
      ],
    },
  ];
  const r = parseSubscription(JSON.stringify(configs));
  assert.equal(r.format, 'xray-json');
  assert.equal(r.nodes.length, 2);
  const reality = r.nodes[0];
  assert.equal(reality.host, '188.130.209.185');
  assert.equal(reality.port, 443);
  assert.ok(reality.link.startsWith('vless://uuid-1@188.130.209.185:443?'));
  assert.ok(reality.link.includes('security=reality'));
  assert.ok(reality.link.includes('pbk=PBK'));
  assert.ok(reality.link.includes('sid=SID'));
  assert.ok(reality.link.includes('flow=xtls-rprx-vision'));
  const ws = r.nodes[1];
  assert.equal(ws.host, 'ws.example.ru');
  assert.ok(ws.link.includes('type=ws'));
  assert.ok(ws.link.includes('security=tls'));
  assert.ok(ws.link.includes('path=%2Fchws'));
  // Восстановленная ссылка должна снова разбираться как обычная подписка.
  const back = parseSubscription([reality.link, ws.link].join('\n'));
  assert.equal(back.nodes.length, 2);
});

test('Subscription-Userinfo парсится в байты и срок', () => {
  const u = parseSubUserinfo('upload=100; download=200; total=107374182400; expire=1767225600');
  assert.equal(u.upload, 100);
  assert.equal(u.download, 200);
  assert.equal(u.total, 107374182400);
  assert.equal(u.expire, 1767225600);
  assert.deepEqual(parseSubUserinfo(null), {});
  assert.deepEqual(parseSubUserinfo(''), {});
});
