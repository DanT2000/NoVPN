// Генерация полного Xray-конфига: обход «белых списков» + аварийный фоллбэк.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWhitelistXrayConfig, normalizeWhitelistRoutes, RU_WHITELIST_ROUTES } from '@novpn/shared';
import type { ProxyFallback } from '@novpn/shared';

const LINK =
  'vless://b0cac4d7-e2a6-40a7-ba6e-a946bcbe6243@1.vpn.example.com:443?type=tcp&security=reality&pbk=ABC&fp=edge&sni=cdn.dodostatic.net&sid=39a4&spx=%2F&flow=xtls-rprx-vision&encryption=none#NoVPN-x';

test('buildWhitelistXrayConfig: reality-outbound + маршрутизация (без прокси)', () => {
  const cfg = JSON.parse(buildWhitelistXrayConfig([LINK], 'NoVPN'));
  const proxy = cfg.outbounds.find((o: any) => o.protocol === 'vless');
  assert.ok(proxy);
  assert.equal(proxy.tag, 'proxy-t0-0');
  const vnext = proxy.settings.vnext[0];
  assert.equal(vnext.address, '1.vpn.example.com');
  assert.equal(vnext.users[0].id, 'b0cac4d7-e2a6-40a7-ba6e-a946bcbe6243');
  const rs = proxy.streamSettings.realitySettings;
  assert.equal(rs.serverName, 'cdn.dodostatic.net');
  assert.equal(rs.fingerprint, 'edge');
  assert.equal(rs.spiderX, '/');
  assert.ok(cfg.outbounds.some((o: any) => o.tag === 'direct'));
  const directRule = cfg.routing.rules.find((r: any) => r.domain && r.outboundTag === 'direct');
  assert.ok(directRule && directRule.domain.includes('domain:gosuslugi.ru'));
  assert.equal(directRule.domain.length, RU_WHITELIST_ROUTES.length);
  // sniffing на инбаундах — иначе правила domain: не сработают для HTTPS (TUN).
  const socksIn = cfg.inbounds.find((i: any) => i.tag === 'socks');
  const httpIn = cfg.inbounds.find((i: any) => i.tag === 'http');
  assert.equal(socksIn.sniffing.enabled, true);
  assert.ok(socksIn.sniffing.destOverride.includes('tls'));
  assert.equal(socksIn.sniffing.routeOnly, true);
  assert.equal(httpIn.sniffing.enabled, true);
  assert.equal(cfg.routing.domainMatcher, 'hybrid');
  // один тир → без балансировщиков, дефолт напрямую на proxy-t0-0
  assert.ok(!cfg.balancers && !cfg.observatory);
  const last = cfg.routing.rules[cfg.routing.rules.length - 1];
  assert.equal(last.outboundTag, 'proxy-t0-0');
});

test('редактируемый список доменов: кастомные маршруты попадают в direct-правило', () => {
  const custom = ['domain:example.com', ' ', '# коммент', 'plain.ru', 'domain:example.com'];
  const cfg = JSON.parse(buildWhitelistXrayConfig([LINK], 'NoVPN', [], '', custom));
  const directRule = cfg.routing.rules.find((r: any) => r.domain && r.outboundTag === 'direct');
  assert.deepEqual(directRule.domain, ['domain:example.com', 'domain:plain.ru']); // trim/comment/пусто отброшены, bare → domain:, дедуп
});

test('редактируемый список доменов: пустой/мусорный список → дефолт RU_WHITELIST_ROUTES', () => {
  const cfg = JSON.parse(buildWhitelistXrayConfig([LINK], 'NoVPN', [], '', ['   ', '# только комментарий']));
  const directRule = cfg.routing.rules.find((r: any) => r.domain && r.outboundTag === 'direct');
  assert.equal(directRule.domain.length, RU_WHITELIST_ROUTES.length); // fallback на дефолт, не пусто
});

test('normalizeWhitelistRoutes: trim, префикс domain:, дедуп, отброс комментариев', () => {
  assert.deepEqual(
    normalizeWhitelistRoutes(['ya.ru', 'domain:ya.ru', '  vk.com  ', '', '# c', 'geosite:ru']),
    ['domain:ya.ru', 'domain:vk.com', 'geosite:ru'],
  );
});

test('lanAccess=false (по умолчанию): приватные адреса идут direct (правило есть)', () => {
  const cfg = JSON.parse(buildWhitelistXrayConfig([LINK], 'NoVPN'));
  const privRule = cfg.routing.rules.find((r: any) => r.outboundTag === 'direct' && Array.isArray(r.ip));
  assert.ok(privRule, 'должно быть правило direct для приватных подсетей');
  assert.ok(privRule.ip.includes('192.168.0.0/16'));
});

test('lanAccess=true: правило direct для приватных адресов убрано (идут через туннель)', () => {
  const cfg = JSON.parse(buildWhitelistXrayConfig([LINK], 'NoVPN', [], '', undefined, true));
  const privRule = cfg.routing.rules.find((r: any) => r.outboundTag === 'direct' && Array.isArray(r.ip));
  assert.equal(privRule, undefined, 'приватные адреса не должны форситься в direct при lanAccess');
});

test('disableWhitelist=true + lanAccess=true: полный туннель — НИКАКИХ direct-исключений', () => {
  const cfg = JSON.parse(buildWhitelistXrayConfig([LINK], 'NoVPN', [], '', undefined, true, true));
  const directDomain = cfg.routing.rules.find((r: any) => r.outboundTag === 'direct' && r.domain);
  const privIp = cfg.routing.rules.find((r: any) => r.outboundTag === 'direct' && Array.isArray(r.ip));
  const torrent = cfg.routing.rules.find((r: any) => Array.isArray(r.protocol) && r.protocol.includes('bittorrent'));
  assert.equal(directDomain, undefined, 'РФ-домены идут через VPN, не direct');
  assert.equal(privIp, undefined, 'приватные/локалка через VPN (lanAccess)');
  assert.equal(torrent, undefined, 'торренты через VPN');
  assert.match(cfg.remarks, /через VPN/);
});

test('QUIC-блок: UDP/443 в blackhole, ПОСЛЕ whitelist-direct (RU QUIC остаётся direct)', () => {
  const cfg = JSON.parse(buildWhitelistXrayConfig([LINK], 'NoVPN'));
  const rules = cfg.routing.rules;
  const quic = rules.find((r: any) => r.outboundTag === 'block' && r.network === 'udp' && r.port === 443);
  assert.ok(quic, 'должно быть правило блокировки QUIC (udp/443 → block)');
  const directIdx = rules.findIndex((r: any) => r.outboundTag === 'direct' && r.domain);
  const quicIdx = rules.findIndex((r: any) => r.outboundTag === 'block' && r.network === 'udp');
  assert.ok(directIdx >= 0 && quicIdx > directIdx, 'QUIC-блок должен идти ПОСЛЕ whitelist-direct, чтобы RU QUIC уходил direct');
});

test('QUIC-блок присутствует и в конфиге с прокси-фоллбэком (многотировом)', () => {
  const proxies: ProxyFallback[] = [{ kind: 'socks', host: '1.vpn.example.com', port: 1080, user: 'u', pass: 'p' }];
  const cfg = JSON.parse(buildWhitelistXrayConfig([LINK], 'NoVPN', proxies));
  const quic = cfg.routing.rules.find((r: any) => r.outboundTag === 'block' && r.network === 'udp' && r.port === 443);
  assert.ok(quic, 'QUIC-блок должен быть и в многотировом конфиге с балансировщиками');
});

test('бренд в remarks: без имени сервера используется appName (кастомный бренд)', () => {
  const cfg = JSON.parse(buildWhitelistXrayConfig([LINK], 'МойСервис'));
  assert.match(cfg.remarks, /^МойСервис — обход/);
});

test('buildWhitelistXrayConfig: несколько Xray-серверов без прокси — балансировщик по тиру 0', () => {
  const LINK2 =
    'vless://11111111-2222-3333-4444-555555555555@2.vpn.example.com:443?type=tcp&security=reality&pbk=DEF&fp=edge&sni=cdn.dodostatic.net&sid=aa&spx=%2F&flow=xtls-rprx-vision&encryption=none#NoVPN-x2';
  const cfg = JSON.parse(buildWhitelistXrayConfig([LINK, LINK2], 'NoVPN'));
  // Оба сервера — outbounds tier 0; балансировщик leastPing по proxy-t0-, а не только первый.
  assert.ok(cfg.outbounds.some((o: any) => o.tag === 'proxy-t0-0'));
  assert.ok(cfg.outbounds.some((o: any) => o.tag === 'proxy-t0-1'));
  assert.ok(cfg.observatory && cfg.observatory.subjectSelector.includes('proxy-t0-'));
  assert.equal(cfg.routing.balancers.length, 1);
  assert.equal(cfg.routing.balancers[0].selector[0], 'proxy-t0-');
  assert.equal(cfg.routing.balancers[0].fallbackTag, 'direct');
  // RU-домены по-прежнему напрямую.
  assert.ok(cfg.routing.rules.some((r: any) => r.outboundTag === 'direct' && r.domain));
});

test('buildWhitelistXrayConfig: аварийный фоллбэк Xray→HTTPS→HTTP→SOCKS (тиры)', () => {
  const proxies: ProxyFallback[] = [
    { kind: 'https', host: '1.vpn.example.com', port: 8443, user: 'u', pass: 'p' },
    { kind: 'http', host: '1.vpn.example.com', port: 8080, user: 'u', pass: 'p' },
    { kind: 'socks', host: '1.vpn.example.com', port: 1080, user: 'u', pass: 'p' },
  ];
  const cfg = JSON.parse(buildWhitelistXrayConfig([LINK], 'NoVPN', proxies));
  // 4 тира: xray(t0) + https(t1) + http(t2) + socks(t3)
  assert.ok(cfg.outbounds.some((o: any) => o.tag === 'proxy-t0-0' && o.protocol === 'vless'));
  const https = cfg.outbounds.find((o: any) => o.tag === 'proxy-t1-0');
  assert.equal(https.protocol, 'http');
  assert.equal(https.streamSettings.security, 'tls'); // HTTPS-прокси через TLS
  assert.equal(cfg.outbounds.find((o: any) => o.tag === 'proxy-t2-0').protocol, 'http');
  assert.equal(cfg.outbounds.find((o: any) => o.tag === 'proxy-t3-0').protocol, 'socks');
  // observatory + балансировщики с цепочкой fallbackTag
  assert.ok(cfg.observatory && cfg.observatory.subjectSelector.includes('proxy-t'));
  const bs = cfg.routing.balancers;
  assert.equal(bs.length, 4);
  assert.equal(bs[0].selector[0], 'proxy-t0-'); // Xray первый
  assert.equal(bs[0].fallbackTag, 'loop-1'); // при падении Xray → следующий тир
  assert.equal(bs[3].fallbackTag, 'direct'); // все мертвы → напрямую
  // dokodemo-инбаунды и loopback-аутбаунды для тиров 1..3
  assert.equal(cfg.inbounds.filter((i: any) => i.protocol === 'dokodemo-door').length, 3);
  assert.equal(cfg.outbounds.filter((o: any) => o.protocol === 'loopback').length, 3);
  // RU-домены по-прежнему напрямую
  assert.ok(cfg.routing.rules.some((r: any) => r.outboundTag === 'direct' && r.domain));
});
