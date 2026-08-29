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

const { TELEGRAM_CIDRS, TELEGRAM_DOMAINS, OPENAI_DOMAINS, DIRECT_DOMAINS, builtinRules } = await import('../src/lib/builtinRoutes.js');
const { parseRuleLine } = await import('../src/lib/routingRules.js');
const repo = await import('../src/repo.js');
const { db } = await import('../src/db.js');

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

test('ChatGPT: добиваем пробелы, но общую капчу Cloudflare в туннель не тащим', () => {
  // Основные домены приходят из внешней базы суффиксом, здесь — только то, чего там нет.
  for (const d of ['openai.org', 'featuregates.org', 'statsigapi.net'])
    assert.ok(OPENAI_DOMAINS.includes(d), `пробел ${d} не закрыт`);
  // challenges.cloudflare.com общий для тысяч сайтов: в туннеле он ломал бы проверку
  // у российских сайтов, которые идут напрямую.
  assert.ok(!OPENAI_DOMAINS.includes('challenges.cloudflare.com'));
  assert.ok(builtinRules().some((r) => r.kind === 'domain' && r.value === 'openai.org'));
});

// Внешние списки заворачивают в VPN только ЧАСТЬ GitHub (api.github.com и Copilot),
// а github.com и githubusercontent.com оставляют напрямую. Клиент авторизуется в API
// с адреса VPN, а файлы тянет со своего — «GitHub нормально не работает». Разрыв вреднее
// любого из направлений, поэтому сводим всё к одному.
test('GitHub идёт целиком напрямую, а Copilot — через VPN', () => {
  for (const d of ['github.com', 'raw.githubusercontent.com', 'release-assets.githubusercontent.com', 'ghcr.io'])
    assert.ok(DIRECT_DOMAINS.includes(d), `${d} должен быть в прямых`);
  // Ключевая тонкость: НЕ весь githubusercontent.com суффиксом. На его поддоменах живёт
  // Copilot, он в России заблокирован и обязан идти через VPN — широкое правило
  // утащило бы его напрямую и сломало.
  assert.ok(!DIRECT_DOMAINS.includes('githubusercontent.com'), 'суффикс целиком брать нельзя');
  assert.ok(!DIRECT_DOMAINS.some((d) => d.includes('copilot')), 'Copilot напрямую не пускаем');
  const rules = builtinRules();
  const gh = rules.filter((r) => DIRECT_DOMAINS.includes(r.value));
  assert.ok(gh.length > 0);
  assert.ok(gh.every((r) => r.action === 'direct'), 'все github-правила — «напрямую»');
  // Telegram при этом остаётся в VPN: действия не перепутаны.
  assert.equal(rules.find((r) => r.value === 't.me')!.action, 'vpn');
  assert.equal(rules.find((r) => r.value === '149.154.160.0/20')!.action, 'vpn');
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

// Человека надо предупредить ДО отключения: «внезапно перестало работать» он
// воспринимает как поломку, а не как исчерпанный тариф.
test('остаток трафика: предупреждаем тех, у кого меньше 10% лимита', () => {
  const mk = (name: string, limit: number | null, used: number) => {
    const u = repo.insertUser({
      name, comment: '', category: null, tags: [], code: `c${Math.random().toString(36).slice(2, 8)}`,
      deviceLimit: 1, expiresAt: null, trafficLimitGb: limit, resetPolicy: 'never',
      allowedServers: [], allowedProtocols: ['xray'],
    });
    if (used) repo.addUserTraffic?.(u.id, used);
    return u;
  };
  const low = mk('Заканчивается', 10, 0);
  const fine = mk('Ещё много', 10, 0);
  const unlimited = mk('Безлимит', null, 0);
  // Выставляем расход напрямую: способ пополнения счётчика тут не важен.
  db.prepare('UPDATE users SET traffic_used_gb = ? WHERE id = ?').run(9.5, low.id);
  db.prepare('UPDATE users SET traffic_used_gb = ? WHERE id = ?').run(3, fine.id);
  db.prepare('UPDATE users SET traffic_used_gb = ? WHERE id = ?').run(999, unlimited.id);

  const ids = repo.listUsersLowOnTraffic(0.1).map((u) => u.id);
  assert.ok(ids.includes(low.id), 'осталось 0.5 из 10 ГБ — предупреждаем');
  assert.ok(!ids.includes(fine.id), 'потрачено 3 из 10 — рано');
  assert.ok(!ids.includes(unlimited.id), 'безлимитных не трогаем вовсе');

  // Исчерпавшего лимит сюда не берём: ему уходит другое сообщение — про отключение.
  db.prepare('UPDATE users SET traffic_used_gb = ? WHERE id = ?').run(10, low.id);
  assert.ok(!repo.listUsersLowOnTraffic(0.1).some((u) => u.id === low.id));
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
