// Юнит-тесты чистых функций агента: разбор положительных int из env и перевод
// человекочитаемого трафика в байты. Покрывают два реальных дефекта:
//  - posInt: пустой/нулевой/отрицательный env давал 0 (busy-loop setInterval);
//  - bytesFrom: не знал TiB/PiB и брал десятичные множители для двоичных единиц
//    → тера-объёмы читались почти нулём (недосчёт квоты).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { posInt } from '../src/config.js';
import { bytesFrom } from '../src/drivers/amneziawg.js';

test('posInt: только строго положительное число, иначе дефолт', () => {
  assert.equal(posInt('20', 5), 20);
  assert.equal(posInt('9090', 9090), 9090);
  assert.equal(posInt('', 5), 5); // Number('') === 0
  assert.equal(posInt(undefined, 5), 5);
  assert.equal(posInt('0', 5), 5);
  assert.equal(posInt('-3', 5), 5);
  assert.equal(posInt('abc', 5), 5);
  assert.equal(posInt('1.5', 7), 1.5); // дробное положительное допустимо
});

test('bytesFrom: двоичные единицы, включая TiB/PiB', () => {
  assert.equal(bytesFrom('1 B'), 1);
  assert.equal(bytesFrom('1 KiB'), 1024);
  assert.equal(bytesFrom('1 MiB'), 1024 ** 2);
  assert.equal(bytesFrom('1 GiB'), 1024 ** 3);
  assert.equal(bytesFrom('1.5 TiB'), Math.round(1.5 * 1024 ** 4));
  assert.equal(bytesFrom('2 PiB'), 2 * 1024 ** 5);
  assert.equal(bytesFrom(''), null);
  assert.equal(bytesFrom('no-number'), null);
});

test('bytesFrom: большой TiB НЕ схлопывается в байты (регресс недосчёта квоты)', () => {
  const v = bytesFrom('1.5 TiB');
  assert.ok(v !== null && v > 1e12, `ожидалось ~1.65e12, получено ${v}`);
});
