// Генерация полного Xray-конфига с обходом «белых списков».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWhitelistXrayConfig, RU_WHITELIST_ROUTES } from '@novpn/shared';

const LINK =
  'vless://b0cac4d7-e2a6-40a7-ba6e-a946bcbe6243@1.vpn.appswire.ru:443?type=tcp&security=reality&pbk=ABC&fp=edge&sni=cdn.dodostatic.net&sid=39a4&spx=%2F&flow=xtls-rprx-vision&encryption=none#NoVPN-x';

test('buildWhitelistXrayConfig: валидный JSON с reality-outbound и маршрутизацией', () => {
  const cfg = JSON.parse(buildWhitelistXrayConfig([LINK], 'NoVPN'));
  // outbound reality собран из ссылки
  const proxy = cfg.outbounds.find((o: any) => o.protocol === 'vless');
  assert.ok(proxy, 'есть vless-outbound');
  const vnext = proxy.settings.vnext[0];
  assert.equal(vnext.address, '1.vpn.appswire.ru');
  assert.equal(vnext.port, 443);
  assert.equal(vnext.users[0].id, 'b0cac4d7-e2a6-40a7-ba6e-a946bcbe6243');
  assert.equal(vnext.users[0].flow, 'xtls-rprx-vision');
  const rs = proxy.streamSettings.realitySettings;
  assert.equal(rs.serverName, 'cdn.dodostatic.net');
  assert.equal(rs.fingerprint, 'edge');
  assert.equal(rs.spiderX, '/');
  // freedom(direct) и blackhole(block) присутствуют
  assert.ok(cfg.outbounds.some((o: any) => o.protocol === 'freedom' && o.tag === 'direct'));
  assert.ok(cfg.outbounds.some((o: any) => o.protocol === 'blackhole'));
  // маршрутизация: RU-домены → direct, дефолт → proxy
  const directRule = cfg.routing.rules.find((r: any) => r.domain && r.outboundTag === 'direct');
  assert.ok(directRule, 'есть правило RU-доменов напрямую');
  assert.ok(directRule.domain.includes('domain:gosuslugi.ru'));
  assert.ok(directRule.domain.length === RU_WHITELIST_ROUTES.length);
  const last = cfg.routing.rules[cfg.routing.rules.length - 1];
  assert.equal(last.outboundTag, 'proxy-0'); // всё остальное — через прокси
});

test('buildWhitelistXrayConfig: несколько ссылок — несколько outbound, дефолт на первый', () => {
  const l2 = LINK.replace('1.vpn.appswire.ru', '2.vpn.appswire.ru');
  const cfg = JSON.parse(buildWhitelistXrayConfig([LINK, l2]));
  const proxies = cfg.outbounds.filter((o: any) => o.protocol === 'vless');
  assert.equal(proxies.length, 2);
  const last = cfg.routing.rules[cfg.routing.rules.length - 1];
  assert.equal(last.outboundTag, 'proxy-0');
});
