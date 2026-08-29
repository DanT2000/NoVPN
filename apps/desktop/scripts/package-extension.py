#!/usr/bin/env python3
"""Собирает архивы расширения под три магазина.

Почему не один архив на всех: у Firefox другой движок манифеста. MV3-фон там —
`background.scripts` (событийная страница), а не service worker; расширение обязано
иметь свой идентификатор в `browser_specific_settings.gecko.id` (по нему приложение
пускает его к нативному хосту); поля `key` и `minimum_chrome_version` он не понимает.

Поле `key` убирается и у Chrome с Edge: оно нужно только при разработке, чтобы
идентификатор не менялся. В магазине идентификатор выдаёт сам магазин, а лишний ключ
в манифесте — повод для отказа на проверке.
"""
import json
import shutil
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXT = ROOT / "extension"
OUT = EXT / "store" / "dist"
FIREFOX_ID = "novpn@appswire.ru"

FILES = ["manifest.json", "background.js", "popup.html", "popup.css", "popup.js", "icons"]


def read_manifest() -> dict:
    return json.loads((EXT / "manifest.json").read_text(encoding="utf-8"))


def chromium_manifest() -> dict:
    m = read_manifest()
    m.pop("key", None)  # идентификатор выдаёт магазин
    return m


def firefox_manifest() -> dict:
    m = read_manifest()
    m.pop("key", None)
    m.pop("minimum_chrome_version", None)
    # Событийная страница вместо service worker: Firefox service_worker в MV3 не поддерживает.
    m["background"] = {"scripts": ["background.js"]}
    m["browser_specific_settings"] = {"gecko": {"id": FIREFOX_ID, "strict_min_version": "128.0"}}
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
    WEB_PUBLIC.mkdir(parents=True, exist_ok=True)
    for item in made:
        shutil.copy2(item, WEB_PUBLIC / item.name)
    print("версия расширения:", version)
    for item in made:
        print("  %s  %d байт" % (item.name, item.stat().st_size))
    print("архивы:", OUT)
    print("раздача панелью:", WEB_PUBLIC)


if __name__ == "__main__":
    main()
