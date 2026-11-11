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

test('дедуп: точный повтор (в том числе с другим #именем) схлопывается', () => {
  const r = parseSubscription([vless, vless, vless.replace(/#.*$/, '#Другое имя')].join('\n'));
  assert.equal(r.nodes.length, 1);
  const vm2 = 'vmess://' + Buffer.from(JSON.stringify({ ...vmessJson, ps: 'Germany 2' })).toString('base64');
  assert.equal(parseSubscription([vmess, vm2].join('\n')).nodes.length, 1, 'vmess: тот же JSON без ps — повтор');
});

// Подписка под белые списки: один сервер с разными SNI (у операторов в белом списке
// разные домены), CDN-ws с разным path/Host на одном адресе. Прежний ключ
// protocol|host|port оставлял только первый вариант.
test('дедуп: разные конфиги на одном host:port — разные узлы', () => {
  const lines = [
    'vless://u1@1.2.3.4:443?type=tcp&security=reality&sni=vk.com&pbk=P&sid=1#WL-vk',
    'vless://u1@1.2.3.4:443?type=tcp&security=reality&sni=ya.ru&pbk=P&sid=1#WL-ya',
    'vless://u1@1.2.3.4:443?type=tcp&security=reality&sni=gosuslugi.ru&pbk=P&sid=1#WL-gu',
    'vless://u2@cdn.example.com:443?type=ws&security=tls&path=%2Fnl&host=nl.example.com#NL',
    'vless://u3@cdn.example.com:443?type=ws&security=tls&path=%2Fde&host=de.example.com#DE',
  ];
  const r = parseSubscription(lines.join('\n'));
  assert.deepEqual(r.nodes.map((n) => n.name), ['WL-vk', 'WL-ya', 'WL-gu', 'NL', 'DE']);
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

test('ss:// без порта (внутренний userinfo): host не теряет символ, порт 443', () => {
  // Всё тело — base64(method:pass@host) без :port. Прежде host = hp.slice(0,-1)
  // («ss.example.co»), порт = NaN. Регресс на splitHostPort.
  const line = 'ss://' + Buffer.from('aes-256-gcm:pw@ss.example.com').toString('base64') + '#NoPort';
  const r = parseSubscription(line);
  const sh = r.nodes.find((n) => n.protocol === 'ss');
  assert.ok(sh, 'узел ss должен разобраться');
  assert.equal(sh!.host, 'ss.example.com');
  assert.equal(sh!.port, 443);
});

test('ss:// без порта (внешний userinfo): host корректен, порт 443', () => {
  const line = 'ss://' + Buffer.from('aes-256-gcm:password123').toString('base64') + '@ss.example.com#NoPort2';
  const r = parseSubscription(line);
  const sh = r.nodes.find((n) => n.protocol === 'ss');
  assert.ok(sh);
  assert.equal(sh!.host, 'ss.example.com');
  assert.equal(sh!.port, 443);
});

test('ss:// с одиночным «%» в имени не теряется', () => {
  const line = 'ss://' + Buffer.from('aes-256-gcm:pass').toString('base64') + '@1.2.3.4:8388#50%off';
  const sh = parseSubscription(line).nodes.find((n) => n.protocol === 'ss');
  assert.ok(sh, 'узел ss не должен выпадать из-за имени');
  assert.equal(sh!.host, '1.2.3.4');
  assert.equal(sh!.port, 8388);
  assert.equal(sh!.name, '50%off');
});

// У владельца реально работает резерв с XHTTP-серверами. Провайдер с Xray-JSON (формат
// v2rayN): ссылку собирает панель, и без path/host/mode клиент стучится в «/» — сервер,
// который ждёт свой путь, соединение отбивает.
test('Xray-JSON: XHTTP/splithttp/httpupgrade — path, host, mode и extra доходят до ссылки', () => {
  const xhttp = (extra: Record<string, unknown>) => ({
    remarks: 'NL xhttp',
    outbounds: [
      {
        protocol: 'vless',
        settings: { vnext: [{ address: 'nl.example.com', port: 443, users: [{ id: 'u1', encryption: 'none' }] }] },
        streamSettings: {
          network: 'xhttp',
          security: 'reality',
          realitySettings: { serverName: 'www.google.com', fingerprint: 'chrome', publicKey: 'PBK', shortId: 'ab' },
          xhttpSettings: { path: '/secret', host: 'cdn.example.com', mode: 'stream-one', ...extra },
        },
      },
    ],
  });
  const r = parseSubscription(JSON.stringify([xhttp({ extra: { xPaddingBytes: '100-1000', noGRPCHeader: true } })]));
  assert.equal(r.format, 'xray-json');
  const u = new URL(r.nodes[0]!.link);
  assert.equal(u.searchParams.get('type'), 'xhttp');
  assert.equal(u.searchParams.get('path'), '/secret');
  assert.equal(u.searchParams.get('host'), 'cdn.example.com');
  assert.equal(u.searchParams.get('mode'), 'stream-one');
  assert.deepEqual(JSON.parse(u.searchParams.get('extra')!), { xPaddingBytes: '100-1000', noGRPCHeader: true });
  assert.equal(u.searchParams.get('pbk'), 'PBK');

  // extra нет, но поля лежат прямо в xhttpSettings — Xray их применяет, значит и ссылка
  // обязана их нести (в extra, как у v2rayN).
  const flat = new URL(parseSubscription(JSON.stringify(xhttp({ xPaddingBytes: '1-2' }))).nodes[0]!.link);
  assert.deepEqual(JSON.parse(flat.searchParams.get('extra')!), { xPaddingBytes: '1-2' });
  // Голые path/host/mode — без лишнего extra.
  const bare = new URL(parseSubscription(JSON.stringify(xhttp({}))).nodes[0]!.link);
  assert.equal(bare.searchParams.get('extra'), null);

  // Прежнее имя транспорта (splithttp) и httpupgrade.
  const legacy = JSON.parse(JSON.stringify(xhttp({})));
  legacy.outbounds[0].streamSettings.network = 'splithttp';
  legacy.outbounds[0].streamSettings.splithttpSettings = legacy.outbounds[0].streamSettings.xhttpSettings;
  delete legacy.outbounds[0].streamSettings.xhttpSettings;
  const sh = new URL(parseSubscription(JSON.stringify(legacy)).nodes[0]!.link);
  assert.equal(sh.searchParams.get('path'), '/secret');
  assert.equal(sh.searchParams.get('mode'), 'stream-one');
  const hu = JSON.parse(JSON.stringify(xhttp({})));
  hu.outbounds[0].streamSettings = { network: 'httpupgrade', security: 'tls', tlsSettings: { serverName: 'hu.example.com' }, httpupgradeSettings: { path: '/up', host: 'hu.example.com' } };
  const hl = new URL(parseSubscription(JSON.stringify(hu)).nodes[0]!.link);
  assert.equal(hl.searchParams.get('path'), '/up');
  assert.equal(hl.searchParams.get('host'), 'hu.example.com');

  // vmess поверх xhttp: path/host в JSON ссылки (раньше брались только из wsSettings).
  const vm = JSON.parse(JSON.stringify(xhttp({})));
  vm.outbounds[0].protocol = 'vmess';
  vm.outbounds[0].streamSettings.security = 'none';
  const vmLink = parseSubscription(JSON.stringify(vm)).nodes[0]!.link;
  const vmBody = JSON.parse(Buffer.from(vmLink.slice('vmess://'.length), 'base64').toString('utf8'));
  assert.equal(vmBody.path, '/secret');
  assert.equal(vmBody.host, 'cdn.example.com');
});

// Конфиг с балансировщиком держит несколько серверов, раньше брался только первый.
test('Xray-JSON: все прокси-outbound одного конфига, звено цепочки — не сервер', () => {
  const ob = (tag: string, host: string, extra: Record<string, unknown> = {}) => ({
    tag,
    protocol: 'vless',
    settings: { vnext: [{ address: host, port: 443, users: [{ id: 'u', encryption: 'none' }] }] },
    streamSettings: { network: 'tcp', security: 'reality', realitySettings: { serverName: 'x', publicKey: 'P', shortId: '1' } },
    ...extra,
  });
  const cfg = {
    remarks: 'Auto',
    outbounds: [
      ob('proxy-1', 'a.example'),
      ob('proxy-2', 'b.example'),
      ob('proxy-3', 'c.example', { streamSettings: { network: 'tcp', security: 'none', sockopt: { dialerProxy: 'hop' } } }),
      ob('hop', 'relay.example'),
      { protocol: 'freedom', tag: 'direct' },
    ],
    routing: { balancers: [{ tag: 'b', selector: ['proxy-'] }] },
  };
  const r = parseSubscription(JSON.stringify(cfg));
  assert.deepEqual(r.nodes.map((n) => n.host), ['a.example', 'b.example', 'c.example'], 'три сервера, звено цепочки отдельно не считаем');
  assert.deepEqual(r.nodes.map((n) => n.name), ['Auto · proxy-1', 'Auto · proxy-2', 'Auto · proxy-3']);
  // Тот же сервер отдельным конфигом рядом с «Авто» — остаётся одно понятное имя.
  const single = { remarks: 'A отдельно', outbounds: [ob('proxy', 'a.example')] };
  const both = parseSubscription(JSON.stringify([cfg, single]));
  assert.equal(both.nodes.filter((n) => n.host === 'a.example').length, 1);
  assert.equal(both.nodes.find((n) => n.host === 'a.example')!.name, 'A отдельно');
});
