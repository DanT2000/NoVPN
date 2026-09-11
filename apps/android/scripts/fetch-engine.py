#!/usr/bin/env python3
"""Скачивает движок mihomo под Android в app/src/main/jniLibs.

В git движка нет — как и у десктопа (apps/desktop/scripts/fetch-engine.ps1).
Версия закреплена здесь намеренно и совпадает с десктопной: поведение движка от
версии к версии меняется, а конфиг у обоих клиентов один и тот же.

Файл кладётся под именем lib<что-то>.so не для красоты: Android разрешает
запускать исполняемые файлы только из nativeLibraryDir, а туда попадает лишь
то, что упаковано как нативная библиотека (см. useLegacyPackaging в build.gradle.kts).

    python scripts/fetch-engine.py [--force]
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import os
import sys
import urllib.request

MIHOMO = "v1.19.30"

# ABI Android → имя сборки в релизе mihomo.
ABIS = {
    "arm64-v8a": f"mihomo-android-arm64-v8-{MIHOMO}.gz",
    "armeabi-v7a": f"mihomo-android-armv7-{MIHOMO}.gz",
    "x86_64": f"mihomo-android-amd64-{MIHOMO}.gz",
}

BASE = f"https://github.com/MetaCubeX/mihomo/releases/download/{MIHOMO}"
# Зеркало: прямой github с российских адресов часто не открывается, панель ходит
# через него же (см. desktop-update-channel в заметках проекта).
MIRRORS = ["https://ghfast.top/", ""]

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JNI = os.path.join(ROOT, "app", "src", "main", "jniLibs")


def fetch(url: str) -> bytes:
    last: Exception | None = None
    for prefix in MIRRORS:
        full = f"{prefix}{url}" if prefix else url
        try:
            print(f"  <- {full}")
            req = urllib.request.Request(full, headers={"User-Agent": "novpn-fetch-engine"})
            with urllib.request.urlopen(req, timeout=180) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001 — причина неважна, важен следующий источник
            print(f"     не вышло: {e}")
            last = e
    raise SystemExit(f"Не удалось скачать {url}: {last}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="перекачать, даже если файл на месте")
    args = ap.parse_args()

    for abi, asset in ABIS.items():
        out_dir = os.path.join(JNI, abi)
        out = os.path.join(out_dir, "libmihomo.so")
        if os.path.exists(out) and not args.force:
            print(f"{abi}: уже на месте ({os.path.getsize(out) // 1024} КБ)")
            continue
        raw = fetch(f"{BASE}/{asset}")
        binary = gzip.decompress(raw)
        os.makedirs(out_dir, exist_ok=True)
        tmp = out + ".tmp"
        with open(tmp, "wb") as f:
            f.write(binary)
        os.replace(tmp, out)
        digest = hashlib.sha256(binary).hexdigest()[:16]
        print(f"{abi}: mihomo {MIHOMO} -> {out} ({len(binary) // 1024} КБ, sha256 {digest}…)")

    print("\nГотово. Движок в app/src/main/jniLibs, в git он не попадает.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
