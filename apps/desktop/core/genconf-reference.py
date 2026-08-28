# -*- coding: utf-8 -*-
"""Подписка NoVPN (Xray JSON) → конфиг Mihomo.

Главное в этом переводе — направление правил. У Mihomo последним стоит
`MATCH,DIRECT`, то есть всё, что не названо явно, идёт напрямую. Это ровно та
модель, которая нужна: человек перечисляет только то, чему нужен VPN.
"""

import io
import json
import sys


def parse_subscription(raw: str):
    """Достаёт из подписки список точек: имя и параметры VLESS+REALITY."""
    data = json.loads(raw)
    out = []
    for cfg in data:
        name = cfg.get('remarks') or 'Без названия'
        for ob in cfg.get('outbounds', []):
            if ob.get('protocol') != 'vless':
                continue
            if not (ob.get('streamSettings') or {}).get('realitySettings'):
                continue
            v = ob['settings']['vnext'][0]
            u = v['users'][0]
            st = ob['streamSettings']
            rs = st['realitySettings']
            out.append({
                'name': clean(name),
                'server': v['address'],
                'port': int(v['port']),
                'uuid': u['id'],
                'flow': u.get('flow') or '',
                'sni': rs.get('serverName'),
                'fp': rs.get('fingerprint') or 'chrome',
                'pbk': rs.get('publicKey'),
                'sid': rs.get('shortId') or '',
            })
            break  # из каждого профиля берём основную точку
    return out


def clean(s: str) -> str:
    """Имя точки без эмодзи и служебных хвостов — оно попадёт в конфиг и в UI."""
    s = s.split('|')[0].strip()
    return ''.join(c for c in s if c.isalnum() or c in ' -_#').strip() or 'Сервер'


def yaml_str(s: str) -> str:
    return '"%s"' % str(s).replace('"', '\\"')


def build(proxies, rules_apps, rules_vpn_domains, rules_direct_domains,
          port=7899, controller_port=9899, selected=None):
    names = [p['name'] for p in proxies]
    sel = selected or names[0]
    L = []
    add = L.append

    add('# Конфиг собран приложением NoVPN. Править вручную нет смысла —')
    add('# он пересобирается при каждом подключении.')
    add('mixed-port: %d' % port)
    add('allow-lan: false')
    add('mode: rule')
    add('log-level: warning')
    add('ipv6: false')
    add('external-controller: 127.0.0.1:%d' % controller_port)
    add('')
    add('dns:')
    add('  enable: true')
    add('  ipv6: false')
    add('  enhanced-mode: fake-ip')
    add('  fake-ip-range: 198.18.0.1/16')
    add('  nameserver:')
    add('    - https://1.1.1.1/dns-query')
    add('    - https://dns.google/dns-query')
    add('')
    add('proxies:')
    for p in proxies:
        add('  - name: %s' % yaml_str(p['name']))
        add('    type: vless')
        add('    server: %s' % p['server'])
        add('    port: %d' % p['port'])
        add('    uuid: %s' % p['uuid'])
        add('    network: tcp')
        add('    tls: true')
        add('    udp: true')
        if p['flow']:
            add('    flow: %s' % p['flow'])
        add('    servername: %s' % p['sni'])
        add('    client-fingerprint: %s' % p['fp'])
        add('    reality-opts:')
        add('      public-key: %s' % p['pbk'])
        if p['sid']:
            add('      short-id: %s' % p['sid'])
    add('')
    add('proxy-groups:')
    add('  - name: NoVPN')
    add('    type: select')
    add('    proxies:')
    add('      - %s' % yaml_str(sel))
    for n in names:
        if n != sel:
            add('      - %s' % yaml_str(n))
    add('')
    add('rules:')
    # Порядок здесь — не косметика. Mihomo берёт первое совпавшее правило,
    # поэтому российские домены стоят выше правил по приложениям: иначе
    # Discord, открывший Госуслуги, увёл бы их за границу и сломал.
    add('  # 1. Обязаны идти напрямую — сильнее любого правила по приложению')
    for d in rules_direct_domains:
        add('  - DOMAIN-SUFFIX,%s,DIRECT' % d)
    add('  # 2. Приложения, которым нужен VPN')
    for proc in rules_apps:
        add('  - PROCESS-NAME,%s,NoVPN' % proc)
    add('  # 3. Домены, которым нужен VPN')
    for d in rules_vpn_domains:
        add('  - DOMAIN-SUFFIX,%s,NoVPN' % d)
    add('  # Локальные сети — всегда мимо туннеля. Явными подсетями, а не GEOIP:')
    add('  # база geoip тянется из интернета, а приложение обязано подниматься без сети.')
    for net in ('127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16'):
        add('  - IP-CIDR,%s,DIRECT,no-resolve' % net)
    add('  # Всё остальное идёт напрямую. Это и есть модель NoVPN.')
    add('  - MATCH,DIRECT')
    return '\n'.join(L) + '\n'


if __name__ == '__main__':
    sub = io.open(sys.argv[1], encoding='utf-8').read()
    px = parse_subscription(sub)
    print('точек в подписке:', len(px))
    for p in px:
        print('  %-14s %s:%s  sni=%s' % (p['name'], p['server'], p['port'], p['sni']))

    presets = json.load(io.open(sys.argv[2], encoding='utf-8'))
    apps = [pr for a in presets['items'] if a['route'] == 'vpn' for pr in a['processes']]
    sites = json.load(io.open(sys.argv[3], encoding='utf-8'))
    vpn_d = [s['domain'] for s in sites['items'] if s['route'] == 'vpn']
    dir_d = [s['domain'] for s in sites['items'] if s['route'] == 'direct']

    # Для проверки разделения выбираем HomeVPN: он выходит в Кемерово, а прямой
    # трафик сейчас уходит в Финляндию через активный Amnezia — разница видна.
    home = next((p['name'] for p in px if 'Finland' in p['name']), px[0]['name'])
    conf = build(px, apps, vpn_d, dir_d, selected=home)
    io.open(sys.argv[4], 'w', encoding='utf-8').write(conf)
    print('\nконфиг записан: %s' % sys.argv[4])
    print('правил: %d по процессам, %d доменов через VPN, %d напрямую'
          % (len(apps), len(vpn_d), len(dir_d)))
    print('выбрана точка: %s' % home)
