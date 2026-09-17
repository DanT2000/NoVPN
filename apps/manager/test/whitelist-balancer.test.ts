// Регресс на невалидный Xray-конфиг: правило маршрутизации ссылалось на балансировщик
// lb0, который в ветке одного канала НЕ создавался (match-vpn + один прокси, ноль
// валидных vless). Инвариант: каждый balancerTag в routing.rules существует в
// routing.balancers — иначе Xray/клиент отвергает профиль целиком.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWhitelistXrayConfig, type ProxyFallback } from '@novpn/shared';

function assertNoDanglingBalancer(json: string): void {
  const cfg = JSON.parse(json) as { routing?: { rules?: Array<Record<string, unknown>>; balancers?: Array<{ tag: string }> } };
  const rules = cfg.routing?.rules ?? [];
  const balancers = new Set((cfg.routing?.balancers ?? []).map((b) => b.tag));
  for (const r of rules) {
    if (typeof r.balancerTag === 'string') {
      assert.ok(balancers.has(r.balancerTag), `правило ссылается на несуществующий балансировщик ${r.balancerTag}`);
    }
  }
}

const proxy: ProxyFallback = { kind: 'socks', host: 'p.example', port: 1080, user: 'u', pass: 'x' };
const VLESS = 'vless://11111111-1111-1111-1111-111111111111@a.example:443?security=reality&pbk=K&flow=xtls-rprx-vision#Node';
const WL = ['example.com', 'test.org'];

test('match-vpn: один прокси, ноль валидных vless → нет висячего lb0', () => {
  const json = buildWhitelistXrayConfig(['garbage-not-vless'], 'NoVPN', [proxy], 'S', WL, false, false, { direction: 'match-vpn' });
  assert.notEqual(json, '', 'должен быть валидный конфиг (есть один канал — прокси)');
  assertNoDanglingBalancer(json);
});

test('match-vpn: один vless без прокси → нет висячего lb0', () => {
  const json = buildWhitelistXrayConfig([VLESS], 'NoVPN', [], 'S', WL, false, false, { direction: 'match-vpn' });
  assertNoDanglingBalancer(json);
});

test('match-vpn: vless + прокси (мульти-тир) → lb0 определён и используется', () => {
  const json = buildWhitelistXrayConfig([VLESS], 'NoVPN', [proxy], 'S', WL, false, false, { direction: 'match-vpn' });
  const cfg = JSON.parse(json) as { routing: { balancers: Array<{ tag: string }> } };
  assert.ok(new Set(cfg.routing.balancers.map((b) => b.tag)).has('lb0'));
  assertNoDanglingBalancer(json);
});

test('match-vpn: два прокси, ноль vless (мульти-тир) → нет висячего балансировщика', () => {
  const json = buildWhitelistXrayConfig(['garbage'], 'NoVPN', [proxy, { ...proxy, host: 'p2.example' }], 'S', WL, false, false, { direction: 'match-vpn' });
  assertNoDanglingBalancer(json);
});

test('ни одного канала (битый vless, нет прокси) → пустая строка, а не direct-утечка', () => {
  const json = buildWhitelistXrayConfig(['garbage'], 'NoVPN', [], 'S', WL, false, false, { direction: 'match-vpn' });
  assert.equal(json, '');
});
