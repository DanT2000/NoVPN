// geosite.dat / geoip.dat: кодер даёт настоящий protobuf V2Ray, а не «что-то похожее».
// Проверяем независимым декодером (тот же файл, но другой код-путь) и руками по байтам.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeGeoSite, encodeGeoIp, decodeGeoSite, decodeGeoIp } from '../src/lib/geodat.js';

test('geosite: типы доменов кодируются по enum V2Ray (keyword=0 regex=1 domain=2 full=3)', () => {
  const buf = encodeGeoSite([
    { kind: 'domain', value: 'example.com' },
    { kind: 'full', value: 'exact.example.com' },
    { kind: 'keyword', value: 'google' },
    { kind: 'regexp', value: '^ad\\.' },
  ]);
  const [entry] = decodeGeoSite(buf);
  assert.equal(entry!.tag, 'NOVPN');
  assert.deepEqual(
    entry!.domains.map((d) => [d.type, d.value]),
    [
      [2, 'example.com'],
      [3, 'exact.example.com'],
      [0, 'google'],
      [1, '^ad\\.'],
    ],
  );
});

test('geosite: байты детерминированы и начинаются с тега поля 1 (GeoSiteList.entry)', () => {
  const a = encodeGeoSite([{ kind: 'domain', value: 'a.ru' }]);
  const b = encodeGeoSite([{ kind: 'domain', value: 'a.ru' }]);
  assert.deepEqual(a, b);
  assert.equal(a[0], 0x0a, 'field 1, wire type 2');
  // внутри entry: field 1 (country_code) = "NOVPN"
  assert.equal(a[2], 0x0a);
  assert.equal(a[3], 5);
  assert.equal(a.subarray(4, 9).toString('utf8'), 'NOVPN');
});

test('geoip: IPv4/IPv6 адреса и маски, невалидное пропускается', () => {
  const buf = encodeGeoIp(['10.0.0.0/8', '1.2.3.4', '2001:db8::/32', 'мусор', '300.1.1.1']);
  const [entry] = decodeGeoIp(buf);
  assert.equal(entry!.tag, 'NOVPN');
  assert.equal(entry!.cidrs.length, 3, 'два невалидных отброшены');
  assert.deepEqual([...entry!.cidrs[0]!.ip], [10, 0, 0, 0]);
  assert.equal(entry!.cidrs[0]!.prefix, 8);
  assert.equal(entry!.cidrs[1]!.prefix, 32, 'голый IPv4 → /32');
  assert.equal(entry!.cidrs[2]!.ip.length, 16, 'IPv6 — 16 байт');
  assert.equal(entry!.cidrs[2]!.ip.readUInt16BE(0), 0x2001);
  assert.equal(entry!.cidrs[2]!.ip.readUInt16BE(2), 0x0db8);
  assert.equal(entry!.cidrs[2]!.prefix, 32);
});

test('пустой датасет — валидный файл с пустым тегом, а не ноль байт', () => {
  const [gs] = decodeGeoSite(encodeGeoSite([]));
  assert.equal(gs!.tag, 'NOVPN');
  assert.equal(gs!.domains.length, 0);
  const [gi] = decodeGeoIp(encodeGeoIp([]));
  assert.equal(gi!.cidrs.length, 0);
});
