// SSRF-защита резервных подписок: классификатор внутренних адресов, проверка URL
// и чтение тела с лимитом. Покрывает фикс, из-за которого пользователь мог заставить
// панель сходить на 169.254.169.254 / 127.0.0.1 / внутреннюю сеть или положить её OOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateIp, assertPublicUrl, readTextCapped, resolveLookupForm } from '../src/lib/safeFetch.js';

test('isPrivateIp: внутренние/служебные диапазоны → true', () => {
  for (const ip of [
    '127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '172.31.255.255',
    '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:10.1.2.3',
    // IPv4-mapped в HEX-форме (обходили фильтр → SSRF на loopback/metadata):
    '::ffff:7f00:1', '::ffff:a9fe:a9fe', '::ffff:c0a8:101',
    // fe80::/10 целиком (раньше проскакивали fe81..fe8f):
    'fe81::1', 'fe8a::1', 'febf::1',
    '64:ff9b::1', // NAT64
  ]) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
});

test('isPrivateIp: публичные адреса → false', () => {
  for (const ip of [
    '1.1.1.1', '8.8.8.8', '93.184.216.34', '172.15.0.1', '172.32.0.1', '11.0.0.1',
    '2606:4700:4700::1111', '::ffff:8.8.8.8',
  ]) {
    assert.equal(isPrivateIp(ip), false, ip);
  }
});

test('isPrivateIp: мусор → true (fail-closed)', () => {
  for (const s of ['', 'not-an-ip', '999.1.1.1', '10.0.0', '10.0.0.0.0']) {
    assert.equal(isPrivateIp(s), true, s);
  }
});

test('assertPublicUrl: литеральные внутренние адреса отвергаются', async () => {
  for (const url of [
    'http://169.254.169.254/latest/meta-data/',
    'http://127.0.0.1:8080/x',
    'http://[::1]/',
    'https://192.168.2.15/',
    'http://10.8.0.1/',
  ]) {
    await assert.rejects(() => assertPublicUrl(url), url);
  }
});

test('assertPublicUrl: не-http(s) схемы отвергаются', async () => {
  for (const url of ['file:///etc/passwd', 'ftp://example.com/', 'gopher://127.0.0.1/', 'not a url']) {
    await assert.rejects(() => assertPublicUrl(url), url);
  }
});

test('assertPublicUrl: публичный литеральный IP проходит (без DNS)', async () => {
  await assert.doesNotReject(() => assertPublicUrl('http://1.1.1.1/sub'));
  await assert.doesNotReject(() => assertPublicUrl('https://8.8.8.8/'));
});

test('resolveLookupForm: all=true → массив (Happy-Eyeballs), all=false → одиночный (address,family)', () => {
  const pub = [
    { address: '1.1.1.1', family: 4 },
    { address: '8.8.8.8', family: 4 },
  ];
  // Happy-Eyeballs включён (autoSelectFamily): Node ждёт массив адресов.
  const asArray = resolveLookupForm(pub, true);
  assert.deepEqual(asArray, { single: false, addresses: pub });
  // autoSelectFamily ВЫКЛЮЧЕН (options.all=undefined/false): Node ждёт (address, family).
  // Раньше всегда отдавали массив → ERR_INVALID_IP_ADDRESS на каждом коннекте.
  assert.deepEqual(resolveLookupForm(pub, undefined), { single: true, address: '1.1.1.1', family: 4 });
  assert.deepEqual(resolveLookupForm(pub, false), { single: true, address: '1.1.1.1', family: 4 });
});

test('resolveLookupForm: приватный адрес/пустой список → error (fail-closed)', () => {
  assert.ok('error' in resolveLookupForm([], true));
  assert.ok('error' in resolveLookupForm([{ address: '127.0.0.1', family: 4 }], false));
  // Даже один внутренний среди публичных валит всю резолвизацию (rebinding-защита).
  assert.ok('error' in resolveLookupForm([{ address: '1.1.1.1', family: 4 }, { address: '169.254.169.254', family: 4 }], true));
});

test('readTextCapped: тело в пределах лимита читается', async () => {
  assert.equal(await readTextCapped(new Response('hello'), 100), 'hello');
});

test('readTextCapped: превышение лимита прерывает и бросает', async () => {
  await assert.rejects(() => readTextCapped(new Response('x'.repeat(5000)), 100));
});
