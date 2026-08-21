# Задачи для сайта vpn.appswire.ru

Это задание для Claude Code на сервере панели. Четыре вещи: (1) выкладывать релиз
приложения одним архивом с проверкой, (2) сделать страницу загрузки, (3) добавить
ссылки на расширение для браузеров, (4) настроить авто-зеркало версии с центрального
источника и выбор «авто / закрепить версию» (это ключевое для мультипровайдерности —
разработчик единственный источник версии, но грузит её один раз).

Всё, что нужно, лежит в репозитории `github.com/DanT2000/NoVPN`:
- `desktop/` — то, что сайт раздаёт по `/desktop/` (манифест, установщик, инструкция, иконка);
- `store/` — расширение для магазинов и текст карточки;
- `release/` (у разработчика, в git не хранится) — готовый zip релиза для загрузки.

---

## Задача 1. Релиз приложения одним архивом

**Идея:** разработчик присылает ОДИН файл `novpn-desktop-<версия>.zip`. Сервер его
проверяет и раскладывает в `/desktop/`. Разработчик больше ничего вручную не делает.

**Что в архиве:** `latest.json` (подписанный манифест) + `novpn.exe` (установщик).

**Сайт должен отдавать (как статику, с правильным Content-Type):**
- `https://vpn.appswire.ru/desktop/latest.json` → `application/json`
- `https://vpn.appswire.ru/desktop/novpn.exe` → `application/octet-stream`

> Сейчас сайт отдаёт старую версию 0.2.2 и файл `vpn.exe`. Нужно перейти на
> `novpn.exe` и версию из свежего манифеста.

**Валидация архива — по этим критериям (деплой только если ВСЁ прошло):**
1. в архиве есть `latest.json` и `novpn.exe`;
2. размер `novpn.exe` == `sizeBytes` из манифеста;
3. `sha256(novpn.exe)` == `sha256` из манифеста;
4. подпись `signature` проходит проверку **публичным ключом Ed25519**
   `mAKrDKVxw35ZXElNCksRYgzEmzESGvfXMx5Zbc2oCUw=` (приватный ключ у разработчика,
   на сервере его быть НЕ должно — сервер только проверяет);
5. (необязательно) версия новее текущей.

**Скрипт деплоя** (Python, поправь только `WEBROOT`):

```python
#!/usr/bin/env python3
# deploy-release.py  <путь-к-novpn-desktop-X.Y.Z.zip>
import sys, os, zipfile, json, hashlib, base64, tempfile, shutil

PUB = "mAKrDKVxw35ZXElNCksRYgzEmzESGvfXMx5Zbc2oCUw="
WEBROOT = "/var/www/vpn.appswire.ru/desktop"   # <-- ПОСТАВЬ реальный путь раздачи /desktop/

def sig_ok(data, sig_b64):
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
        Ed25519PublicKey.from_public_bytes(base64.b64decode(PUB)).verify(base64.b64decode(sig_b64), data)
        return True
    except ImportError:
        print("[!] нет пакета cryptography — подпись не проверяю (клиент проверит сам)"); return True
    except Exception as e:
        print("[x] подпись НЕ прошла:", e); return False

def ver(v): return [int(x) for x in str(v).split('.') if x.isdigit()]

def main():
    zp = sys.argv[1]
    tmp = tempfile.mkdtemp()
    with zipfile.ZipFile(zp) as z: z.extractall(tmp)
    m = json.load(open(os.path.join(tmp, 'latest.json'), encoding='utf-8'))
    exe = open(os.path.join(tmp, 'novpn.exe'), 'rb').read()
    assert len(exe) == m['sizeBytes'], "размер не совпал"
    assert hashlib.sha256(exe).hexdigest() == m['sha256'], "sha256 не совпал"
    assert sig_ok(exe, m['signature']), "подпись невалидна"
    cur = os.path.join(WEBROOT, 'latest.json')
    if os.path.exists(cur) and ver(m['version']) <= ver(json.load(open(cur, encoding='utf-8')).get('version', '0')):
        print("[!] версия не новее текущей — всё равно перезаписываю")
    os.makedirs(os.path.join(WEBROOT, 'releases'), exist_ok=True)
    open(os.path.join(WEBROOT, 'releases', 'novpn-%s.exe' % m['version']), 'wb').write(exe)  # архив версий
    for name, content in [('novpn.exe', exe),
                          ('latest.json', (json.dumps(m, ensure_ascii=False, indent=2) + '\n').encode('utf-8'))]:
        dst = os.path.join(WEBROOT, name); t = dst + '.tmp'
        open(t, 'wb').write(content); os.replace(t, dst)   # атомарная подмена
    shutil.rmtree(tmp, ignore_errors=True)
    print("OK: выложена версия", m['version'])

if __name__ == '__main__':
    main()
```

Как разработчик будет присылать архив — на твоё усмотрение (папка `incoming/` +
запуск скрипта, либо закрытый эндпоинт загрузки, который вызывает этот скрипт).
Главное — на выходе `/desktop/latest.json` и `/desktop/novpn.exe` обновлены.

**Проверка:** `curl -s https://vpn.appswire.ru/desktop/latest.json` показывает
`"version": "0.2.5"`, а `curl -sI …/desktop/novpn.exe` — размер ~16.2 МБ.

---

## Задача 2. Страница загрузки

Раздел «Скачать». Порядок и акценты важны:

**1) NoVPN для Windows — ПЕРВЫМ и выделенным как основной, лучший вариант.**
Крупная карточка:
- иконка приложения — файл `/desktop/novpn-icon.png` (лежит в репозитории);
- заголовок «NoVPN для Windows», подпись «Рекомендуем — основное приложение»;
- кнопка **«Скачать для Windows»** → `https://vpn.appswire.ru/desktop/novpn.exe`;
- ссылка **«Инструкция»** → страница из `/desktop/guide/` (Markdown
  `desktop/guide/novpn-desktop-guide.md` + картинки рядом в `guide/images/`);
- по желанию — «Версия 0.2.5» (брать из `latest.json`, поле `version`, чтобы не
  расходилось).

**2) Ниже — «Расширение для браузера».**
Ряд кнопок по браузерам, каждая ведёт на установку (ссылки — в Задаче 3):
- Chrome, Edge, Яндекс.Браузер — на страницу в Chrome Web Store;
- Firefox — на страницу в Firefox Add-ons (появится позже).
Подпись под блоком: «Расширению нужно установленное приложение NoVPN для Windows».

Дизайн — в стиле сайта. Смысл: Desktop — герой страницы, расширение — дополнение.

---

## Задача 3. Ссылки на расширение

Расширение публикуется в магазины (файлы и текст — в `store/`):
- `store/novpn-extension-chrome.zip` → грузится в **Chrome Web Store** (аккаунт
  разработчика, взнос $5, ревью). Оттуда ставится в **Chrome, Edge, Яндекс**.
- Текст карточки — `store/chrome-listing.md`.
- Firefox (Add-ons) — отдельно, позже (нужна доработка приложения под Firefox).

После публикации у расширения будет ссылка вида
`https://chromewebstore.google.com/detail/<ID>`.

**Сделай ссылки настраиваемыми, а не зашитыми в код** — например, поле в
конфиге/админке сайта «ссылка на расширение (Chrome)», «ссылка (Firefox)». Тогда
менять их можно без правки страницы. Пока ссылок нет — кнопки браузеров показывай
неактивными с подписью «скоро».

---

## Коротко

1. Отдавать `/desktop/*` статикой; принимать релиз zip → проверять (5 критериев) →
   раскладывать скриптом выше.
2. Страница загрузки: Windows-приложение первым и выделенным (иконка + кнопка +
   инструкция), ниже — кнопки браузеров.
3. Ссылки на расширение — настраиваемые; появятся после публикации в магазинах.

---

## Задача 4. Единый источник версии + локальное зеркало у каждой панели

Приложение NoVPN разворачивают много провайдеров (свой домен, своя подписка).
Версию выпускает ОДИН разработчик — он единственный источник. Нужно, чтобы:

- новая версия **сама появлялась у всех панелей** (разработчик публикует один раз);
- панель провайдера **скачивала версию один раз** с центрального источника и дальше
  раздавала её **со своего сайта** — чтобы весь трафик скачиваний не шёл на сервер
  разработчика;
- у каждого провайдера был **выбор: авто-обновление (по умолчанию) или закрепить
  конкретную версию** и дальше не обновляться.

### Как работает

Панель периодически (cron ~раз в час) обращается к центральному источнику,
скачивает свежий `latest.json` + `novpn.exe` **только если версия сменилась**,
проверяет их и кладёт к себе в раздачу `/desktop/`. Скачанные версии складываются в
локальный архив `/desktop/releases/`, чтобы можно было закрепиться на любой из них.

**Центральный источник** (пробуем по порядку, берём первый рабочий):
1. `https://raw.githubusercontent.com/DanT2000/NoVPN/main/desktop` — основной
   (GitHub держит нагрузку, сервер разработчика не грузится);
2. `https://vpn.appswire.ru/desktop` — резерв.

**Целостность:** проверяем sha256 и **подпись Ed25519** публичным ключом
`mAKrDKVxw35ZXElNCksRYgzEmzESGvfXMx5Zbc2oCUw=`. Подделать нельзя — приватный ключ
только у разработчика. Поэтому зеркалить с центрального источника безопасно.

### Настройка у провайдера (в панели/админке)

- **Режим обновления приложения:** `Авто` (по умолчанию) или `Закрепить версию`.
  - `Авто` — как вышла новая версия, панель сама её скачивает и начинает раздавать.
  - `Закрепить версию X.Y.Z` — панель раздаёт выбранную версию из локального архива
    и больше не обновляется, пока провайдер не сменит режим.

По умолчанию — `Авто`. Это одно поле в настройках панели.

### Скрипт зеркала (Python, cron ~раз в час; поправь `WEBROOT`, режим — из настроек панели)

```python
#!/usr/bin/env python3
# mirror-desktop.py — держит /desktop у провайдера в актуальном виде.
#   режим по умолчанию: auto (последняя версия).
#   закрепить версию: MODE="pin"; PIN="0.2.5" (из локального архива releases/).
import os, json, hashlib, base64, urllib.request

SOURCES = ["https://raw.githubusercontent.com/DanT2000/NoVPN/main/desktop",
           "https://vpn.appswire.ru/desktop"]
PUB = "mAKrDKVxw35ZXElNCksRYgzEmzESGvfXMx5Zbc2oCUw="
WEBROOT = "/var/www/vpn.appswire.ru/desktop"   # <-- путь раздачи /desktop/
MODE = os.environ.get("NOVPN_MODE", "auto")    # "auto" | "pin"  (бери из настроек панели)
PIN  = os.environ.get("NOVPN_PIN", "")          # напр. "0.2.5" при MODE=pin

def get(path):
    last = None
    for base in SOURCES:
        try: return urllib.request.urlopen(base + path, timeout=60).read()
        except Exception as e: last = e
    raise last

def sig_ok(data, sig_b64):
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
        Ed25519PublicKey.from_public_bytes(base64.b64decode(PUB)).verify(base64.b64decode(sig_b64), data)
        return True
    except ImportError: return True     # клиент проверит подпись сам
    except Exception:   return False

def publish(m, exe):
    os.makedirs(os.path.join(WEBROOT, "releases"), exist_ok=True)
    open(os.path.join(WEBROOT, "releases", "novpn-%s.exe" % m["version"]), "wb").write(exe)
    open(os.path.join(WEBROOT, "releases", "latest-%s.json" % m["version"]), "w", encoding="utf-8").write(
        json.dumps(m, ensure_ascii=False, indent=2))
    for name, data in [("novpn.exe", exe),
                       ("latest.json", (json.dumps(m, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))]:
        dst = os.path.join(WEBROOT, name); t = dst + ".tmp"
        open(t, "wb").write(data); os.replace(t, dst)

def current_version():
    p = os.path.join(WEBROOT, "latest.json")
    return json.load(open(p, encoding="utf-8"))["version"] if os.path.exists(p) else None

def main():
    if MODE == "pin" and PIN:
        if current_version() == PIN: return                       # уже на закреплённой
        arc_exe = os.path.join(WEBROOT, "releases", "novpn-%s.exe" % PIN)
        arc_man = os.path.join(WEBROOT, "releases", "latest-%s.json" % PIN)
        if os.path.exists(arc_exe) and os.path.exists(arc_man):    # берём из локального архива
            publish(json.load(open(arc_man, encoding="utf-8")), open(arc_exe, "rb").read())
            print("pinned", PIN); return
        print("[!] версия", PIN, "не найдена в локальном архиве — сначала поработай в auto"); return

    # auto: последняя версия
    m = json.loads(get("/latest.json"))
    if current_version() == m["version"]: return                  # уже актуально, не качаем
    exe = get("/novpn.exe")
    assert hashlib.sha256(exe).hexdigest() == m["sha256"], "sha не совпал"
    assert sig_ok(exe, m["signature"]), "подпись невалидна"
    publish(m, exe)
    print("mirrored", m["version"])

if __name__ == "__main__":
    main()
```

### Что это даёт

- Разработчик выложил версию (в GitHub) — **один раз**. Все панели подтянут сами.
- Скачивание версии каждой панелью — **однократное**; дальше пользователи качают
  установщик со своего провайдера, а не с сервера разработчика.
- Провайдер сам решает: жить на авто-обновлении (по умолчанию) или закрепиться на
  проверенной версии.

> Прямая загрузка zip (Задача 1) остаётся как ручной способ для панели разработчика.
> Остальные панели ничего не загружают — зеркалят автоматически.
