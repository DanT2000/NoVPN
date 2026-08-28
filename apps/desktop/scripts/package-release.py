# -*- coding: utf-8 -*-
"""Собирает ОДИН подписанный релиз-архив для загрузки на сайт.

Одна команда: python scripts/package-release.py "заметки о версии"

Делает:
  1. читает версию из src-tauri/tauri.conf.json (руками нигде не правим);
  2. берёт готовый установщик NoVPN_<версия>_x64-setup.exe;
  3. подписывает Ed25519 (приватный ключ — вне репозитория, см. KEY_PATH);
  4. пишет desktop/latest.json и копирует desktop/vpn.exe (для GitHub);
  5. кладёт ВСЁ в один архив release/novpn-desktop-<версия>.zip — его и грузим
     на сайт. Внутри: latest.json + vpn.exe.

Приватный ключ НИКОГДА не попадает в архив и в репозиторий.
"""
import base64, hashlib, io, json, os, sys, zipfile
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # apps/desktop
NOVPN = os.path.abspath(os.path.join(ROOT, '..', '..'))                # корень монорепо (d:/Project/NoVPN)
DESKTOP = os.path.join(NOVPN, 'desktop')
RELEASE_DIR = os.path.join(NOVPN, 'release')
# Приватный ключ подписи лежит РЯДОМ с репозиторием, не внутри: d:/Project/.novpn-keys
KEY_PATH = os.path.abspath(os.path.join(NOVPN, '..', '.novpn-keys', 'novpn-update-private.key'))
ARTIFACT = 'novpn.exe'
SITE_BASE = 'https://vpn.appswire.ru/desktop'


def version_from_conf():
    conf = json.load(io.open(os.path.join(ROOT, 'src-tauri', 'tauri.conf.json'), encoding='utf-8'))
    return conf['version']


def main():
    notes = sys.argv[1] if len(sys.argv) > 1 else ''
    ver = version_from_conf()
    installer = os.path.join(ROOT, 'src-tauri', 'target', 'release', 'bundle', 'nsis',
                             'NoVPN_%s_x64-setup.exe' % ver)
    if not os.path.exists(installer):
        sys.exit('Не найден установщик %s — сначала `npx tauri build`.' % installer)
    if not os.path.exists(KEY_PATH):
        sys.exit('Не найден приватный ключ %s — без него подпись невозможна.' % KEY_PATH)

    data = io.open(installer, 'rb').read()
    sha = hashlib.sha256(data).hexdigest()
    priv = Ed25519PrivateKey.from_private_bytes(base64.b64decode(io.open(KEY_PATH).read().strip()))
    signature = base64.b64encode(priv.sign(data)).decode()

    manifest = {
        'product': 'NoVPN Desktop', 'version': ver, 'channel': 'stable',
        'mandatory': False, 'minSupportedVersion': '0.1.0',
        'url': SITE_BASE + '/' + ARTIFACT,
        'sha256': sha, 'signature': signature, 'sizeBytes': len(data), 'notes': notes,
    }
    manifest_text = json.dumps(manifest, ensure_ascii=False, indent=2) + '\n'

    # для GitHub-репозитория (резервный канал)
    os.makedirs(DESKTOP, exist_ok=True)
    io.open(os.path.join(DESKTOP, 'latest.json'), 'w', encoding='utf-8', newline='\n').write(manifest_text)
    io.open(os.path.join(DESKTOP, ARTIFACT), 'wb').write(data)

    # ОДИН архив для загрузки на сайт
    os.makedirs(RELEASE_DIR, exist_ok=True)
    zip_path = os.path.join(RELEASE_DIR, 'novpn-desktop-%s.zip' % ver)
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('latest.json', manifest_text)
        z.write(installer, ARTIFACT)

    print('версия:        %s' % ver)
    print('sha256:        %s' % sha)
    print('подпись:       %s…' % signature[:24])
    print('АРХИВ ДЛЯ САЙТА -> %s  (%.1f МБ)' % (zip_path, os.path.getsize(zip_path) / 1e6))
    print('(в архиве: latest.json + vpn.exe. Загрузи его на сайт — остальное сделает деплой-скрипт.)')


if __name__ == '__main__':
    main()
