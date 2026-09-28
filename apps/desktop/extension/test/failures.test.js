// Логика «что на странице не загрузилось». Запуск: node --test apps/desktop/extension/test
import { test } from 'node:test';
import assert from 'node:assert/strict';
await import('../failures.js');
const F = globalThis.NovpnFailures;

test('ошибки соединения — сбой с понятной причиной', () => {
  assert.equal(F.classify('net::ERR_CONNECTION_RESET'), 'сброс соединения');
  assert.equal(F.classify('net::ERR_CONNECTION_CLOSED'), 'сброс соединения');
  assert.equal(F.classify('net::ERR_EMPTY_RESPONSE'), 'сброс соединения');
  assert.equal(F.classify('net::ERR_CONNECTION_TIMED_OUT'), 'нет ответа');
  assert.equal(F.classify('net::ERR_NAME_NOT_RESOLVED'), 'адрес не найден');
  assert.equal(F.classify('net::ERR_SSL_PROTOCOL_ERROR'), 'ошибка защищённого соединения');
  assert.equal(F.classify('net::ERR_CERT_COMMON_NAME_INVALID'), 'ошибка защищённого соединения', 'заглушка провайдера со своим сертификатом');
  assert.equal(F.classify('net::ERR_QUIC_PROTOCOL_ERROR'), 'обрыв соединения');
  assert.equal(F.classify('net::ERR_CONNECTION_REFUSED'), 'соединение отклонено');
  // Firefox
  assert.equal(F.classify('NS_ERROR_NET_RESET'), 'сброс соединения');
  assert.equal(F.classify('NS_ERROR_NET_TIMEOUT'), 'нет ответа');
  assert.equal(F.classify('NS_ERROR_UNKNOWN_HOST'), 'адрес не найден');
});

test('не сбой сети: отмена, блокировщик рекламы, кэш, нет интернета вовсе, DNS-фильтр', () => {
  for (const e of [
    'net::ERR_ABORTED', 'NS_BINDING_ABORTED', 'net::ERR_BLOCKED_BY_CLIENT', 'net::ERR_BLOCKED_BY_ORB',
    'net::ERR_BLOCKED_BY_RESPONSE', 'net::ERR_CACHE_MISS', 'net::ERR_INCOMPLETE_CHUNKED_ENCODING',
    'net::ERR_INTERNET_DISCONNECTED', 'net::ERR_NETWORK_CHANGED', 'net::ERR_ADDRESS_INVALID', '',
  ]) {
    assert.equal(F.classify(e), null, e);
  }
});

test('зависший запрос: без заголовков дольше порога; долгоживущие типы — никогда', () => {
  const now = 100_000;
  assert.equal(F.hungReason({ type: 'script', start: now - F.HUNG_MS, headers: false }, now), F.REASON_HUNG);
  assert.equal(F.hungReason({ type: 'script', start: now - F.HUNG_MS + 1, headers: false }, now), null);
  assert.equal(F.hungReason({ type: 'script', start: 0, headers: true }, now), null, 'ответ уже идёт');
  assert.equal(F.hungReason({ type: 'xmlhttprequest', start: now - F.HUNG_MS, headers: false }, now), null, 'XHR — порог выше (long polling)');
  assert.equal(F.hungReason({ type: 'xmlhttprequest', start: now - F.HUNG_XHR_MS, headers: false }, now), F.REASON_HUNG);
  assert.equal(F.hungReason({ type: 'websocket', start: 0, headers: false }, now), null);
  assert.equal(F.hungReason({ type: 'media', start: 0, headers: false }, now), null);
});

test('хост: локальная сеть и служебные адреса маршрута не выбирают', () => {
  assert.equal(F.hostOf('https://www.Example.com/a'), 'example.com');
  assert.equal(F.hostOf('chrome-extension://abc/x'), null);
  for (const u of ['http://localhost:3000', 'http://192.168.2.5/', 'http://10.0.0.1', 'http://172.20.0.3', 'http://198.18.0.5', 'http://nas.local', 'http://router.lan', 'http://[::1]/']) {
    assert.equal(F.hostOf(u), null, u);
  }
  assert.equal(F.hostOf('https://8.8.8.8/'), '8.8.8.8');
});

test('сводка: только сломанное, по корню домена, реклама отброшена, сам сайт первым', () => {
  const failures = {};
  F.record(failures, 'rr1---sn-abc.googlevideo.com', 'сброс соединения', false);
  F.record(failures, 'rr2---sn-def.googlevideo.com', 'сброс соединения', false);
  F.record(failures, 'rr2---sn-def.googlevideo.com', 'нет ответа', false);
  F.record(failures, 'www.google-analytics.com', 'сброс соединения', false); // шум
  F.record(failures, 'api.site.com', 'адрес не найден', false);
  const now = 100_000;
  const inflight = [
    { host: 'cdn.blocked.net', type: 'image', start: now - 15_000, headers: false }, // висит
    { host: 'fine.org', type: 'image', start: now - 1_000, headers: false }, // ещё грузится — не сбой
    { host: 'mc.yandex.ru', type: 'script', start: 0, headers: false }, // шум
  ];
  const s = F.summarize(failures, inflight, now, 'site.com', 10);
  assert.deepEqual(s.map((x) => x.domain), ['site.com', 'googlevideo.com', 'blocked.net']);
  assert.equal(s[0].self, true);
  assert.equal(s[1].count, 3);
  assert.equal(s[1].reason, 'сброс соединения', 'причина — самая частая');
  assert.equal(s[2].reason, F.REASON_HUNG);
});

test('страница без сбоев — пустая сводка (прежний «список всего подряд» больше не появляется)', () => {
  assert.deepEqual(F.summarize({}, [{ host: 'youtube.com', type: 'sub_frame', start: 99_000, headers: true }], 100_000, 'account.msi.com', 10), []);
});
