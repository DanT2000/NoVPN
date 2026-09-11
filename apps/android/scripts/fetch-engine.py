#!/usr/bin/env python3
"""Скачивает движок mihomo под Android в app/src/main/jniLibs.

В git движка нет — как и у десктопа (apps/desktop/scripts/fetch-engine.ps1).
Версия закреплена здесь намеренно и совпадает с десктопной: поведение движка от
версии к версии меняется, а конфиг у обоих клиентов один и тот же.

Файл кладётся под именем lib<что-то>.so не для красоты: Android разрешает
запускать исполняемые файлы только из nativeLibraryDir, а туда попадает лишь
то, что упаковано как нативная библиотека (см. useLegacyPackaging в build.gradle.kts).

    python scripts/fetch-engine.py [--force] [--update-hashes]
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import os
import sys
import urllib.request

MIHOMO = "v1.19.30"

# ABI Android → (имя сборки в релизе mihomo, sha256 РАСПАКОВАННОГО бинарника).
#
# Сумма закреплена не для порядка. Движок качается через стороннее зеркало
# (прямой github с российских адресов обычно не открывается), и через этот
# бинарник идёт весь трафик пользователя. Без сверки подмена на зеркале уехала
# бы в релиз, подписанный нашим ключом, и никто бы этого не заметил.
#
# При смене версии: поменять MIHOMO, запустить с --update-hashes, глазами сверить
# суммы с опубликованными в релизе mihomo и вписать сюда.
ABIS = {
    "arm64-v8a": (
        "mihomo-android-arm64-v8-{v}.gz",
        "94344144936968f25e7089bbeac2d87f3caf67574ba433511424724ad7435dad",
    ),
    "armeabi-v7a": (
        "mihomo-android-armv7-{v}.gz",
        "db22d32f3d6816daabca14b6df7c5513c1d8d4e636a9ccc7c470ef0d9f36679d",
    ),
    "x86_64": (
        "mihomo-android-amd64-{v}.gz",
        "07f38978fae8067d110acdd78a02af6d37ef8b8719ef67d4f9c0d6c22b9e7781",
    ),
}

BASE = "https://github.com/MetaCubeX/mihomo/releases/download/" + MIHOMO
# Зеркало: прямой github из России обычно недоступен, панель ходит через него же.
MIRRORS = ["https://ghfast.top/", ""]

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JNI = os.path.join(ROOT, "app", "src", "main", "jniLibs")


def fetch(url: str) -> bytes:
    last: Exception | None = None
    for prefix in MIRRORS:
        full = prefix + url if prefix else url
        try:
            print("  <- " + full)
            req = urllib.request.Request(full, headers={"User-Agent": "novpn-fetch-engine"})
            with urllib.request.urlopen(req, timeout=180) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001 — причина неважна, важен следующий источник
            print("     не вышло: " + str(e))
            last = e
    raise SystemExit("Не удалось скачать " + url + ": " + str(last))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="перекачать, даже если файл на месте")
    ap.add_argument(
        "--update-hashes",
        action="store_true",
        help="напечатать суммы скачанного вместо сверки (для смены версии движка)",
    )
    args = ap.parse_args()

    fresh: dict[str, str] = {}
    for abi, (asset_tpl, expected) in ABIS.items():
        asset = asset_tpl.format(v=MIHOMO)
        out_dir = os.path.join(JNI, abi)
        out = os.path.join(out_dir, "libmihomo.so")

        if os.path.exists(out) and not args.force:
            with open(out, "rb") as f:
                have = hashlib.sha256(f.read()).hexdigest()
            if have == expected or args.update_hashes:
                print(abi + ": уже на месте (" + str(os.path.getsize(out) // 1024) + " КБ)")
                fresh[abi] = have
                continue
            print(abi + ": файл на месте, но сумма не та — перекачиваем")

        binary = gzip.decompress(fetch(BASE + "/" + asset))
        digest = hashlib.sha256(binary).hexdigest()
        if not args.update_hashes and digest != expected:
            raise SystemExit(
                abi + ": НЕ СОВПАЛА КОНТРОЛЬНАЯ СУММА движка."
                + "\n  ожидали " + expected
                + "\n  получили " + digest
                + "\nФайл не сохранён. Либо сменилась версия (тогда --update-hashes и сверка"
                + "\nс суммами из релиза mihomo), либо зеркало отдало не то, что нужно."
            )
        os.makedirs(out_dir, exist_ok=True)
        tmp = out + ".tmp"
        with open(tmp, "wb") as f:
            f.write(binary)
        os.replace(tmp, out)
        fresh[abi] = digest
        print(abi + ": mihomo " + MIHOMO + " -> " + out + " (" + str(len(binary) // 1024) + " КБ)")

    if args.update_hashes:
        print("\nСуммы для ABIS (сверьте с релизом mihomo и впишите в этот файл):")
        for abi, digest in fresh.items():
            print('    "' + abi + '": ..., "' + digest + '"')

    print("\nГотово. Движок в app/src/main/jniLibs, в git он не попадает.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
