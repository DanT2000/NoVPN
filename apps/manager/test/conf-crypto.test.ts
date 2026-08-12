// Шифрование .conf в покое: round-trip и обратная совместимость со старым открытым conf.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encConf, decConf, encryptSecret } from '../src/lib/crypto.ts';

const SAMPLE = `[Interface]
Address = 10.8.1.5/32
PrivateKey = aB3cD4eF5gH6iJ7kL8mN9oP0qR1sT2uV3wX4yZ5aB6c=
DNS = 1.1.1.1

[Peer]
PublicKey = xY9zA8bC7dE6fG5hI4jK3lM2nO1pQ0rS9tU8vW7xY6z=
PresharedKey = pQ0rS9tU8vW7xY6zA5bC4dE3fG2hI1jK0lM9nO8pQ7r=
Endpoint = 1.vpn.appswire.ru:40435
AllowedIPs = 0.0.0.0/0`;

test('encConf → decConf возвращает исходный .conf', () => {
  const enc = encConf(SAMPLE)!;
  assert.ok(enc.startsWith('v1.'), 'зашифрованный conf помечен префиксом v1.');
  assert.notEqual(enc, SAMPLE, 'в БД лежит НЕ открытый текст');
  assert.ok(!enc.includes('PrivateKey'), 'приватный ключ не виден в зашифрованном виде');
  assert.equal(decConf(enc), SAMPLE, 'расшифровка восстанавливает точную копию');
});

test('decConf со старым ОТКРЫТЫМ conf отдаёт его как есть (обратная совместимость)', () => {
  assert.equal(decConf(SAMPLE), SAMPLE);
});

test('encConf не шифрует повторно уже зашифрованный (идемпотентность миграции)', () => {
  const once = encConf(SAMPLE)!;
  const twice = encConf(once)!;
  assert.equal(twice, once, 'повторный encConf не создаёт двойное шифрование');
  assert.equal(decConf(twice), SAMPLE);
});

test('encConf/decConf корректны на пустых значениях', () => {
  assert.equal(encConf(null), null);
  assert.equal(encConf(''), ''); // пустую строку не шифруем
  assert.equal(decConf(null), null);
  assert.equal(decConf(undefined), null); // undefined нормализуем в null (тип string | null)
});

test('decConf на битом v1.-шифртексте не бросает, а отдаёт null', () => {
  // Похоже на наш формат, но повреждено → не должно ронять чтение устройства.
  assert.equal(decConf('v1.aaa.bbb.ccc'), null);
});

test('decConf расшифровывает произвольный секрет encryptSecret (общий формат)', () => {
  const enc = encryptSecret('secret-value');
  assert.equal(decConf(enc), 'secret-value');
});
