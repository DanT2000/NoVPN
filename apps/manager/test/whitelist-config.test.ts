// Генерация полного Xray-конфига: обход «белых списков» + аварийный фоллбэк.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWhitelistXrayConfig, normalizeWhitelistRoutes, RU_WHITELIST_ROUTES } from '@novpn/shared';
import type { ProxyFallback } from '@novpn/shared';

const LINK =
  'vless://b0cac4d7-e2a6-40a7-ba6e-a946bcbe6243@1.vpn.example.com:443?type=tcp&security=reality&pbk=ABC&fp=edge&sni=cdn.dodostatic.net&sid=39a4&spx=%2F&flow=xtls-rprx-vision&encryption=none#NoVPN-x';

test('buildWhitelistXrayConfig: reality-outbound + маршрутизация (без прокси)', () => {
  const cfg = JSON.parse(buildWhitelistXrayConfig([LINK], 'NoVPN'));
  const proxy = cfg.outbounds.find((o: any) => o.protocol === 'vless');
  assert.ok(proxy);
  assert.equal(proxy.tag, 'proxy-t0-0');
  const vnext = proxy.settings.vnext[0];
  assert.equal(vnext.address, '1.vpn.example.com');
  assert.equal(vnext.users[0].id, 'b0cac4d7-e2a6-40a7-ba6e-a946bcbe6243');
  const rs = proxy.streamSettings.realitySettings;
  assert.equal(rs.serverName, 'cdn.dodostatic.net');
  assert.equal(rs.fingerprint, 'edge');
  assert.equal(rs.spiderX, '/');
  assert.ok(cfg.outbounds.some((o: any) => o.tag === 'direct'));
  const directRule = cfg.routing.rules.find((r: any) => r.domain && r.outboundTag === 'direct');
  assert.ok(directRule && directRule.domain.includes('domain:gosuslugi.ru'));
  assert.equal(directRule.domain.length, RU_WHITELIST_ROUTES.length);
  // sniffing на инбаундах — иначе правила domain: не сработают для HTTPS (TUN).
  const socksIn = cfg.inbounds.find((i: any) => i.tag === 'socks');
  const httpIn = cfg.inbounds.find((i: any) => i.tag === 'http');
  assert.equal(socksIn.sniffing.enabled, true);
  assert.ok(socksIn.sniffing.destOverride.includes('tls'));
  assert.equal(socksIn.sniffing.routeOnly, true);
  assert.equal(httpIn.sniffing.enabled, true);
  assert.equal(cfg.routing.domainMatcher, 'hybrid');
  // один тир → без балансировщиков, дефолт напрямую на proxy-t0-0
  assert.ok(!cfg.balancers && !cfg.observatory);
  const last = cfg.routing.rules[cfg.routing.rules.length - 1];
  assert.equal(last.outboundTag, 'proxy-t0-0');
});

test('редактируемый список доменов: кастомные маршруты попадают в direct-правило', () => {
  const custom = ['domain:example.com', ' ', '# коммент', 'plain.ru', 'domain:example.com'];
  const cfg = JSON.parse(buildWhitelistXrayConfig([LINK], 'NoVPN', [], '', custom));
  const directRule = cfg.routing.rules.find((r: any) => r.domain && r.outboundTag === 'direct');
  assert.deepEqual(directRule.domain, ['domain:example.com', 'domain:plain.ru']); // trim/comment/пусто отброшены, bare → domain:, дедуп
});

test('редактируемый список доменов: пустой/мусорный список → дефолт RU_WHITELIST_ROUTES', () => {
  const cfg = JSON.parse(buildWhitelistXrayConfig([LINK], 'NoVPN', [], '', ['   ', '# только комментарий']));
  const directRule = cfg.routing.rules.find((r: any) => r.domain && r.outboundTag === 'direct');
  assert.equal(directRule.domain.length, RU_WHITELIST_ROUTES.length); // fallback на дефолт, не пусто
});

test('normalizeWhitelistRoutes: trim, префикс domain:, дедуп, отброс комментариев', () => {
  assert.deepEqual(
    normalizeWhitelistRoutes(['ya.ru', 'domain:ya.ru', '  vk.com  ', '', '# c', 'geosite:ru']),
    ['domain:ya.ru', 'domain:vk.com', 'geosite:ru'],
  );
});

test('lanAccess=false (по умолчанию): приватные адреса идут direct (правило есть)', () => {
  const cfg = JSON.parse(buildWhitelistXrayConfig([LINK], 'NoVPN'));
  const privRule = cfg.routing.rules.find((r: any) => r.outboundTag === 'direct' && Array.isArray(r.ip));
  assert.ok(privRule, 'должно быть правило direct для приватных подсетей');
  assert.ok(privRule.ip.includes('192.168.0.0/16'));
});

test('lanAccess=true: правило direct для приватных адресов убрано (идут через туннель)', () => {
  const cfg = JSON.parse(buildWhitelistXrayConfig([LINK], 'NoVPN', [], '', undefined, true));
  const privRule = cfg.routing.rules.find((r: any) => r.outboundTag === 'direct' && Array.isArray(r.ip));
  assert.equal(privRule, undefined, 'приватные адреса не должны форситься в direct при lanAccess');
});

test('disableWhitelist=true + lanAccess=true: полный туннель — НИКАКИХ direct-исключений', () => {
  const cfg = JSON.parse(buildWhitelistXrayConfig([LINK], 'NoVPN', [], '', undefined, true, true));
  const directDomain = cfg.routing.rules.find((r: any) => r.outboundTag === 'direct' && r.domain);
  const privIp = cfg.routing.rules.find((r: any) => r.outboundTag === 'direct' && Array.isArray(r.ip));
  const torrent = cfg.routing.rules.find((r: any) => Array.isArray(r.protocol) && r.protocol.includes('bittorrent'));
  assert.equal(directDomain, undefined, 'РФ-домены идут через VPN, не direct');
  assert.equal(privIp, undefined, 'приватные/локалка через VPN (lanAccess)');
  assert.equal(torrent, undefined, 'торренты через VPN');
  // remarks = имя без суффикса режима; без title → appName.
  assert.equal(cfg.remarks, 'NoVPN');
});

test('полный туннель fail-close: терминальный fallback балансировщиков = block (не direct)', () => {
  // многотировый (xray + прокси): при disableWhitelist последний тир падает в block, не в direct
  const proxies: ProxyFallback[] = [{ kind: 'socks', host: '1.vpn.example.com', port: 1080, user: 'u', pass: 'p' }];
  const cfg = JSON.parse(buildWhitelistXrayConfig([LINK], 'NoVPN', proxies, '', undefined, true, true));
  const bs = cfg.routing.balancers;
  assert.equal(bs[bs.length - 1].fallbackTag, 'block', 'при падении всех каналов в полном туннеле — блок, не утечка в direct');
  // несколько xray-серверов без прокси: балансировщик тоже fail-close в полном туннеле
  const LINK2 = 'vless://11111111-2222-3333-4444-555555555555@2.vpn.example.com:443?type=tcp&security=reality&pbk=DEF&fp=edge&sni=cdn.dodostatic.net&sid=aa&spx=%2F&flow=xtls-rprx-vision&encryption=none#NoVPN-x2';
  const cfg2 = JSON.parse(buildWhitelistXrayConfig([LINK, LINK2], 'NoVPN', [], '', undefined, true, true));
  assert.equal(cfg2.routing.balancers[0].fallbackTag, 'block');
  // обычный режим не затронут — по-прежнему direct
  const cfg3 = JSON.parse(buildWhitelistXrayConfig([LINK], 'NoVPN', proxies));
  assert.equal(cfg3.routing.balancers[cfg3.routing.balancers.length - 1].fallbackTag, 'direct');
});

test('QUIC-блок: UDP/443 в blackhole, ПОСЛЕ whitelist-direct (RU QUIC остаётся direct)', () => {
  const cfg = JSON.parse(buildWhitelistXrayConfig([LINK], 'NoVPN'));
  const rules = cfg.routing.rules;
  const quic = rules.find((r: any) => r.outboundTag === 'block' && r.network === 'udp' && r.port === 443);
  assert.ok(quic, 'должно быть правило блокировки QUIC (udp/443 → block)');
  const directIdx = rules.findIndex((r: any) => r.outboundTag === 'direct' && r.domain);
  const quicIdx = rules.findIndex((r: any) => r.outboundTag === 'block' && r.network === 'udp');
  assert.ok(directIdx >= 0 && quicIdx > directIdx, 'QUIC-блок должен идти ПОСЛЕ whitelist-direct, чтобы RU QUIC уходил direct');
});

test('QUIC-блок присутствует и в конфиге с прокси-фоллбэком (многотировом)', () => {
  const proxies: ProxyFallback[] = [{ kind: 'socks', host: '1.vpn.example.com', port: 1080, user: 'u', pass: 'p' }];
  const cfg = JSON.parse(buildWhitelistXrayConfig([LINK], 'NoVPN', proxies));
  const quic = cfg.routing.rules.find((r: any) => r.outboundTag === 'block' && r.network === 'udp' && r.port === 443);
  assert.ok(quic, 'QUIC-блок должен быть и в многотировом конфиге с балансировщиками');
});

test('бренд в remarks: без имени сервера используется appName (без суффикса режима)', () => {
  const cfg = JSON.parse(buildWhitelistXrayConfig([LINK], 'МойСервис'));
  assert.equal(cfg.remarks, 'МойСервис');
});

test('buildWhitelistXrayConfig: несколько Xray-серверов без прокси — балансировщик по тиру 0', () => {
  const LINK2 =
    'vless://11111111-2222-3333-4444-555555555555@2.vpn.example.com:443?type=tcp&security=reality&pbk=DEF&fp=edge&sni=cdn.dodostatic.net&sid=aa&spx=%2F&flow=xtls-rprx-vision&encryption=none#NoVPN-x2';
  const cfg = JSON.parse(buildWhitelistXrayConfig([LINK, LINK2], 'NoVPN'));
  // Оба сервера — outbounds tier 0; балансировщик leastPing по proxy-t0-, а не только первый.
  assert.ok(cfg.outbounds.some((o: any) => o.tag === 'proxy-t0-0'));
  assert.ok(cfg.outbounds.some((o: any) => o.tag === 'proxy-t0-1'));
  assert.ok(cfg.observatory && cfg.observatory.subjectSelector.includes('proxy-t0-'));
  assert.equal(cfg.routing.balancers.length, 1);
  assert.equal(cfg.routing.balancers[0].selector[0], 'proxy-t0-');
  assert.equal(cfg.routing.balancers[0].fallbackTag, 'direct');
  // RU-домены по-прежнему напрямую.
  assert.ok(cfg.routing.rules.some((r: any) => r.outboundTag === 'direct' && r.domain));
});

test('buildWhitelistXrayConfig: аварийный фоллбэк Xray→HTTPS→HTTP→SOCKS (тиры)', () => {
  const proxies: ProxyFallback[] = [
    { kind: 'https', host: '1.vpn.example.com', port: 8443, user: 'u', pass: 'p' },
    { kind: 'http', host: '1.vpn.example.com', port: 8080, user: 'u', pass: 'p' },
    { kind: 'socks', host: '1.vpn.example.com', port: 1080, user: 'u', pass: 'p' },
  ];
  const cfg = JSON.parse(buildWhitelistXrayConfig([LINK], 'NoVPN', proxies));
  // 4 тира: xray(t0) + https(t1) + http(t2) + socks(t3)
  assert.ok(cfg.outbounds.some((o: any) => o.tag === 'proxy-t0-0' && o.protocol === 'vless'));
  const https = cfg.outbounds.find((o: any) => o.tag === 'proxy-t1-0');
  assert.equal(https.protocol, 'http');
  assert.equal(https.streamSettings.security, 'tls'); // HTTPS-прокси через TLS
  assert.equal(cfg.outbounds.find((o: any) => o.tag === 'proxy-t2-0').protocol, 'http');
  assert.equal(cfg.outbounds.find((o: any) => o.tag === 'proxy-t3-0').protocol, 'socks');
  // observatory + балансировщики с цепочкой fallbackTag
  assert.ok(cfg.observatory && cfg.observatory.subjectSelector.includes('proxy-t'));
  const bs = cfg.routing.balancers;
  assert.equal(bs.length, 4);
  assert.equal(bs[0].selector[0], 'proxy-t0-'); // Xray первый
  assert.equal(bs[0].fallbackTag, 'loop-1'); // при падении Xray → следующий тир
  assert.equal(bs[3].fallbackTag, 'direct'); // все мертвы → напрямую
  // dokodemo-инбаунды и loopback-аутбаунды для тиров 1..3
  assert.equal(cfg.inbounds.filter((i: any) => i.protocol === 'dokodemo-door').length, 3);
  assert.equal(cfg.outbounds.filter((o: any) => o.protocol === 'loopback').length, 3);
  // RU-домены по-прежнему напрямую
  assert.ok(cfg.routing.rules.some((r: any) => r.outboundTag === 'direct' && r.domain));
});

test('match-vpn (умная маршрутизация): список → В туннель, остальное напрямую, торрент-правила нет, meta.novpn на месте', () => {
  const cfg = JSON.parse(
    buildWhitelistXrayConfig([LINK], 'NoVPN', [], '🇫🇷 Франция', ['blocked.example', 'full:exact.example'], false, false, {
      direction: 'match-vpn',
      ipRoutes: ['10.10.0.0/16'],
      novpn: { profileId: 's1', serverId: 's1', host: '1.vpn.example.com', mode: 'smart' },
      remarkSuffix: '',
    }),
  );
  const listRule = cfg.routing.rules.find((r: any) => r.domain);
  assert.equal(listRule.outboundTag, 'proxy-t0-0', 'домены из списка уходят в VPN');
  assert.deepEqual(listRule.domain, ['domain:blocked.example', 'full:exact.example']);
  const ipRule = cfg.routing.rules.find((r: any) => r.ip && r.ip.includes('10.10.0.0/16'));
  assert.equal(ipRule.outboundTag, 'proxy-t0-0', 'CIDR из списка тоже в VPN');
  assert.ok(!cfg.routing.rules.some((r: any) => r.protocol), 'в match-vpn нет отдельного bittorrent-правила: база и так direct');
  const last = cfg.routing.rules[cfg.routing.rules.length - 1];
  assert.equal(last.outboundTag, 'direct', 'терминальное правило — напрямую');
  assert.equal(cfg.meta.serverDescription, '🇫🇷 Франция');
  assert.deepEqual(cfg.meta.novpn, { profileId: 's1', serverId: 's1', host: '1.vpn.example.com', mode: 'smart' });
  assert.ok(cfg.routing.rules.some((r: any) => r.network === 'udp' && r.port === 443), 'QUIC-блок остаётся');
});

test('match-vpn: QUIC-блок стоит ПЕРЕД правилом VPN-списка (туннелируемый UDP/443 глушится → TCP), но ниже прямых исключений', () => {
  const cfg = JSON.parse(
    buildWhitelistXrayConfig([LINK], 'NoVPN', [], '', ['blocked.example'], false, false, {
      direction: 'match-vpn',
      directRoutes: { domains: ['maps.example'] },
    }),
  );
  const rules = cfg.routing.rules;
  const quicIdx = rules.findIndex((r: any) => r.outboundTag === 'block' && r.network === 'udp' && r.port === 443);
  const listIdx = rules.findIndex((r: any) => r.domain && (r.outboundTag === 'proxy-t0-0' || r.balancerTag));
  assert.ok(quicIdx >= 0 && listIdx >= 0, 'есть и QUIC-блок, и правило списка');
  assert.ok(
    quicIdx < listIdx,
    'QUIC-блок обязан идти ДО правила VPN-списка — иначе UDP/443 к домену из списка уходит туннелем (тот самый «YouTube зависает»)',
  );
  // Прямые исключения (и приватные адреса) остаются ВЫШЕ блока — их QUIC мы не трогаем.
  const exIdx = rules.findIndex((r: any) => r.outboundTag === 'direct' && r.domain);
  const privIdx = rules.findIndex((r: any) => r.outboundTag === 'direct' && r.ip);
  assert.ok(exIdx >= 0 && exIdx < quicIdx, 'direct-исключения выше QUIC-блока (их UDP/443 остаётся)');
  assert.ok(privIdx >= 0 && privIdx < quicIdx, 'приватные адреса выше QUIC-блока');
});

test('match-vpn с пустым списком НЕ подставляет RU-дефолт (это было бы наоборот)', () => {
  const cfg = JSON.parse(buildWhitelistXrayConfig([LINK], 'NoVPN', [], '', [], false, false, { direction: 'match-vpn' }));
  assert.ok(!cfg.routing.rules.some((r: any) => r.domain), 'доменных правил нет');
  const last = cfg.routing.rules[cfg.routing.rules.length - 1];
  assert.equal(last.outboundTag, 'direct');
});

test('match-vpn + прокси-тиры: список → балансировщик lb0, остальное direct, цепочка тиров сохранена', () => {
  const proxies: ProxyFallback[] = [{ kind: 'https', host: 'p.example', port: 8443, user: 'u', pass: 'p' }];
  const cfg = JSON.parse(buildWhitelistXrayConfig([LINK], 'NoVPN', proxies, '', ['blocked.example'], false, false, { direction: 'match-vpn' }));
  const listRule = cfg.routing.rules.find((r: any) => r.domain);
  assert.equal(listRule.balancerTag, 'lb0');
  assert.ok(cfg.routing.balancers.length >= 2, 'тиры есть');
  const direct = cfg.routing.rules.find((r: any) => r.outboundTag === 'direct' && r.network === 'tcp,udp');
  assert.ok(direct, 'терминальное direct-правило');
});

test('приписку получает УМНЫЙ профиль; полный туннель остаётся именем сервера', () => {
  const smart = JSON.parse(
    buildWhitelistXrayConfig([LINK], 'NoVPN', [], '🇫🇷 Франция', ['blocked.example'], false, false, {
      direction: 'match-vpn',
      remarkSuffix: ' · Умная маршрутизация',
      novpn: { mode: 'smart' },
    }),
  );
  assert.equal(smart.remarks, '🇫🇷 Франция · Умная маршрутизация');
  assert.equal(smart.meta.serverDescription, '🇫🇷 Франция · Умная маршрутизация');

  const full = JSON.parse(buildWhitelistXrayConfig([LINK], 'NoVPN', [], '🇫🇷 Франция', [], false, true, { novpn: { mode: 'full' } }));
  assert.equal(full.remarks, '🇫🇷 Франция', 'у полного VPN — просто имя сервера');
  assert.equal(full.meta.serverDescription, '🇫🇷 Франция');
  assert.ok(!full.routing.rules.some((r: any) => r.domain));
});

// Подмена DNS: домен восстанавливается по выданному адресу там, где в трафике его не
// видно (ECH, не-HTTP). Проверено живым Xray 26.3.27: запрос к голому 198.18.x.x
// маршрутизировался как домен из списка, а прямой трафик не сломался.
test('подмена DNS: секция dns и fakedns в сниффере — только в умном профиле', () => {
  const smart = JSON.parse(
    buildWhitelistXrayConfig([LINK], 'NoVPN', [], '🇫🇷 Франция', ['blocked.example'], false, false, {
      direction: 'match-vpn',
      fakeDns: true,
    }),
  );
  assert.deepEqual(smart.dns.servers, ['fakedns', 'localhost'], 'подменный первым, настоящий — системный');
  // Зашитый чужой резолвер сделал бы разрешение имён зависимым от его доступности из
  // сети человека; из России такие адреса регулярно недоступны — отвалился бы и прямой трафик.
  assert.ok(
    !JSON.stringify(smart.dns).match(/\d+\.\d+\.\d+\.\d+|https?:\/\//),
    'никаких чужих резолверов внутри конфига',
  );
  assert.ok(smart.inbounds[0].sniffing.destOverride.includes('fakedns'), 'без этого секция dns не даёт ничего');

  // Полный туннель: маршрутизировать нечего — подмена не нужна даже при включённом флаге.
  const full = JSON.parse(
    buildWhitelistXrayConfig([LINK], 'NoVPN', [], '🇫🇷 Франция', [], false, true, { fakeDns: true, novpn: { mode: 'full' } }),
  );
  assert.equal(full.dns, undefined);
  assert.ok(!full.inbounds[0].sniffing.destOverride.includes('fakedns'));

  // Выключено по умолчанию — конфиг прежний.
  const off = JSON.parse(buildWhitelistXrayConfig([LINK], 'NoVPN', [], '🇫🇷 Франция', ['blocked.example'], false, false, { direction: 'match-vpn' }));
  assert.equal(off.dns, undefined);
  assert.deepEqual(off.inbounds[0].sniffing.destOverride, ['http', 'tls', 'quic']);
});

test('подмена DNS доезжает и до конфига с запасными каналами (многотирная ветка)', () => {
  const proxies: ProxyFallback[] = [{ kind: 'https', host: 'p.example', port: 8443, user: 'u', pass: 'p' }];
  const cfg = JSON.parse(
    buildWhitelistXrayConfig([LINK], 'NoVPN', proxies, '🇫🇷 Франция', ['blocked.example'], false, false, {
      direction: 'match-vpn',
      fakeDns: true,
    }),
  );
  assert.deepEqual(cfg.dns.servers, ['fakedns', 'localhost']);
  assert.ok(cfg.inbounds[0].sniffing.destOverride.includes('fakedns'));
});

test('гео-теги проходят в конфиг как есть: geosite:novpn в domain, geoip:novpn в ip', () => {
  // Компактный конфиг для Happ: база уезжает в DAT, в JSON остаются только ссылки.
  const cfg = JSON.parse(
    buildWhitelistXrayConfig([LINK], 'NoVPN', [], '🇫🇷 Франция', ['geosite:novpn'], false, false, {
      direction: 'match-vpn',
      ipRoutes: ['geoip:novpn'],
    }),
  );
  const domRule = cfg.routing.rules.find((r: any) => r.domain);
  const ipRule = cfg.routing.rules.find((r: any) => r.ip && r.outboundTag !== 'direct');
  assert.deepEqual(domRule.domain, ['geosite:novpn'], 'тег не превратился в domain:geosite:novpn');
  assert.deepEqual(ipRule.ip, ['geoip:novpn']);
  assert.ok(JSON.stringify(cfg).length < 4000, 'конфиг на тегах — килобайты, а не мегабайт');
});
