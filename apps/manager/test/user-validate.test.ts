// Валидация полей пользователя из админ-формы: числовые лимиты (иначе SQLite bind →
// 500) и срок действия (иначе мусорная строка тихо делала пользователя бессрочным —
// NaN < now === false).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normCount, normGb, normExpiry } from '../src/lib/validate.js';

test('normCount: целое ≥ 0 или null', () => {
  assert.deepEqual(normCount(null), { ok: true, value: null });
  assert.deepEqual(normCount(undefined), { ok: true, value: null });
  assert.deepEqual(normCount(''), { ok: true, value: null });
  assert.deepEqual(normCount(0), { ok: true, value: 0 });
  assert.deepEqual(normCount(5), { ok: true, value: 5 });
  assert.deepEqual(normCount('7'), { ok: true, value: 7 });
  for (const bad of [-1, 1.5, NaN, 'abc', {}, [], true, Infinity]) {
    assert.equal(normCount(bad).ok, false, String(bad));
  }
});

test('normGb: число ≥ 0 (дробное можно) или null', () => {
  assert.deepEqual(normGb(0.5), { ok: true, value: 0.5 });
  assert.deepEqual(normGb(100), { ok: true, value: 100 });
  assert.deepEqual(normGb(null), { ok: true, value: null });
  for (const bad of [-0.1, 'x', {}, NaN, Infinity, true]) {
    assert.equal(normGb(bad).ok, false, String(bad));
  }
});

test('normExpiry: реальная дата нормализуется, мусор отвергается', () => {
  assert.deepEqual(normExpiry(null), { ok: true, value: null });
  assert.deepEqual(normExpiry(''), { ok: true, value: null });
  const r = normExpiry('2030-01-15T10:00:00Z');
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value, '2030-01-15T10:00:00.000Z');
  for (const bad of ['garbage', 'hello world', 'не дата', 12345, {}, true]) {
    assert.equal(normExpiry(bad).ok, false, String(bad));
  }
});
