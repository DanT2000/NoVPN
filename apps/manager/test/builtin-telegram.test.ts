// Telegram «работает через раз»: часть боевых сетей мессенджера отсутствует в его же
// официальном cidr.txt, а клиент, не достучавшись до дата-центров, ищет их адреса через
// DoH — если и это идёт мимо туннеля, восстановиться он не может. Здесь фиксируем состав
// встроенного списка и то, что автообновляемые источники подсетей заведены с ВЫСШИМ
// приоритетом (иначе потолок подписки срезал бы их вместе с телеграмом).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = path.join(os.tmpdir(), `novpn-builtin-${process.pid}-${Math.floor(process.hrtime()[1])}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.DATABASE_PATH = path.join(tmp, 'database.sqlite');
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.SESSION_SECRET = 'test';

const { TELEGRAM_CIDRS, TELEGRAM_DOMAINS, builtinRules } = await import('../src/lib/builtinRoutes.js');
const { parseRuleLine } = await import('../src/lib/routingRules.js');
const repo = await import('../src/repo.js');

test('встроенные подсети: официальный список плюс сверенные по RDAP диапазоны', () => {
  // Официальный core.telegram.org/resources/cidr.txt.
  for (const c of ['91.105.192.0/23', '91.108.4.0/22', '149.154.160.0/20', '185.76.151.0/24', '2a0a:f280::/32'])
    assert.ok(TELEGRAM_CIDRS.includes(c), `официальный диапазон ${c} потерян`);
  // Этих в официальном списке НЕТ, а трафик туда идёт (RDAP: TELEGRAM-MESSENGER-INFRA-NET
  // и TM-SUBNETS с теми же контактами, что у Telegram_Messenger_Network).
  assert.ok(TELEGRAM_CIDRS.includes('5.28.192.0/18'), 'без этого диапазона Telegram отваливался');
  assert.ok(TELEGRAM_CIDRS.includes('95.161.64.0/20'));
  // 194.221.0.0/16 в чужих списках встречается, но по RDAP это Vodafone (UK-VEEL), не Telegram.
  assert.ok(!TELEGRAM_CIDRS.includes('194.221.0.0/16'), 'чужая сеть в туннель не заворачивается');
});

test('встроенные домены: резервные точки входа клиента на месте', () => {
  // Штатный обход блокировки в самом Telegram: адреса дата-центров ищутся через DoH.
  for (const d of ['dns.google.com', 'dns.google', 'firebaseremoteconfig.googleapis.com'])
    assert.ok(TELEGRAM_DOMAINS.includes(d), `резервная точка входа ${d} потеряна`);
  for (const d of ['t.me', 'telegram.org', 'telesco.pe']) assert.ok(TELEGRAM_DOMAINS.includes(d));
});

test('все встроенные правила разбираются нашим же разборщиком', () => {
  for (const r of builtinRules()) {
    const parsed = parseRuleLine(r.kind === 'ip' ? r.value : `${r.kind}:${r.value}`);
    assert.ok(parsed, `правило не разбирается: ${r.kind}:${r.value}`);
    assert.equal(parsed.kind, r.kind);
    assert.equal(parsed.value, r.value);
  }
  // Подсети идут первыми — они и есть смысл списка.
  assert.equal(builtinRules()[0]!.kind, 'ip');
});

test('источники подсетей Telegram заведены и стоят выше объёмных списков', () => {
  const sources = repo.listAutoRouteSources();
  const tg = sources.filter((s) => s.id === 'rs_tg_ipv4' || s.id === 'rs_tg_ipv6');
  assert.equal(tg.length, 2, 'оба источника (IPv4 и IPv6) заведены');
  for (const s of tg) {
    assert.ok(s.enabled, 'источник включён');
    assert.equal(s.action, 'vpn');
    assert.match(s.url, /ghfast\.top/, 'через зеркало — прямой github с прод-хоста недоступен');
  }
  // Приоритет: телеграмовские первыми, иначе их подсети срежет потолок подписки.
  const worst = Math.max(...tg.map((s) => s.priority));
  const others = sources.filter((s) => !s.id.startsWith('rs_tg_'));
  assert.ok(others.length > 0, 'обычные источники тоже засеяны');
  assert.ok(others.every((s) => s.priority > worst), 'объёмные списки — ниже телеграмовских');
});
