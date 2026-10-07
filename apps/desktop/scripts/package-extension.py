#!/usr/bin/env python3
"""Собирает архивы расширения под три магазина.

Почему не один архив на всех: у Firefox другой движок манифеста. MV3-фон там —
`background.scripts` (событийная страница), а не service worker; расширение обязано
иметь свой идентификатор в `browser_specific_settings.gecko.id` (по нему приложение
пускает его к нативному хосту); поля `key` и `minimum_chrome_version` он не понимает.

Поле `key` — только для РУЧНОЙ установки (архивы, которые раздаёт панель). При
«загрузить распакованное» именно `key` закрепляет за расширением постоянный
идентификатор fcigljfl…: без него каждый компьютер и профиль получают свой случайный
ID, браузер не пускает расширение к нативному хосту (allowed_origins не совпадает), и
человек видит «приложение не отвечает». Это и была причина «не коннектится на других ПК».

Магазинам `key` отдавать НЕЛЬЗЯ: Chrome Web Store и Edge Add-ons назначают расширению
свой ID и архив с `key` не принимают. Поэтому для них — отдельные архивы *-store.zip без
`key`, а ID, который выдаст магазин, нужно добавить в список разрешённых у нативного
хоста приложения (store/README.md, шаг «ID расширения»).
"""
import json
import shutil
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXT = ROOT / "extension"
OUT = EXT / "store" / "dist"
FIREFOX_ID = "novpn@appswire.ru"

FILES = ["manifest.json", "failures.js", "background.js", "popup.html", "popup.css", "popup.js", "icons"]


def read_manifest() -> dict:
    return json.loads((EXT / "manifest.json").read_text(encoding="utf-8"))


def chromium_manifest() -> dict:
    # `key` НЕ трогаем: он держит постоянный ID при ручной установке (см. шапку).
    return read_manifest()


def store_manifest() -> dict:
    # Для Chrome Web Store / Edge Add-ons: ID выдаёт магазин, `key` он не принимает.
    m = read_manifest()
    m.pop("key", None)
    return m


def firefox_manifest() -> dict:
    m = read_manifest()
    m.pop("key", None)
    m.pop("minimum_chrome_version", None)
    # Событийная страница вместо service worker: Firefox service_worker в MV3 не поддерживает.
    # failures.js — первым: в service worker его подключает importScripts, а здесь — список скриптов.
    m["background"] = {"scripts": ["failures.js", "background.js"]}
    # data_collection_permissions обязателен для новых дополнений на AMO: расширение ничего
    # не отправляет ни разработчику, ни третьим лицам — только локальному приложению.
    m["browser_specific_settings"] = {"gecko": {
        "id": FIREFOX_ID, "strict_min_version": "128.0",
        "data_collection_permissions": {"required": ["none"]},
    }}
    return m


def pack(name: str, manifest: dict) -> Path:
    OUT.mkdir(parents=True, exist_ok=True)
    target = OUT / f"novpn-extension-{name}.zip"
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
        for item in FILES:
            if item == "manifest.json":
                continue
            src = EXT / item
            if src.is_dir():
                for f in sorted(src.rglob("*")):
                    if f.is_file():
                        z.write(f, f.relative_to(EXT).as_posix())
            elif src.exists():
                z.write(src, item)
    return target


# Панель раздаёт архивы как обычную статику фронтенда: так они уезжают вместе с
# деплоем. Папка /desktop для этого не годится — она живёт на постоянном томе и
# засеивается из образа только при первом запуске, на работающей панели новые файлы
# там бы не появились.
WEB_PUBLIC = ROOT.parent / "web" / "public" / "extension"


def main() -> None:
    if OUT.exists():
        shutil.rmtree(OUT)
    version = read_manifest()["version"]
    made = [
        pack("chrome", chromium_manifest()),
        pack("edge", chromium_manifest()),
        pack("firefox", firefox_manifest()),
    ]
    # Архивы для магазинов на панель не кладём: ставить их вручную бессмысленно —
    # без `key` у каждого будет свой ID, и нативный хост его не пустит.
    store = [pack("chrome-store", store_manifest()), pack("edge-store", store_manifest())]
    WEB_PUBLIC.mkdir(parents=True, exist_ok=True)
    for item in made:
        shutil.copy2(item, WEB_PUBLIC / item.name)
    print("версия расширения:", version)
    for item in made + store:
        print("  %s  %d байт" % (item.name, item.stat().st_size))
    print("архивы:", OUT)
    print("раздача панелью:", WEB_PUBLIC)


if __name__ == "__main__":
    main()
