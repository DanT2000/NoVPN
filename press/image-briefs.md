# Брифы для генерации изображений (Codex CLI)

Готовые задания для красивых картинок к статье/репозиторию. Скриншоты лежат в
`press/screenshots/`, логотип — `apps/web/public/icon-192.png` (вордмарк «no**vpn**»,
белое + синее на тёмном), обложка‑референс — `press/cover.svg`.

**Единый стиль (держать во всех картинках):**
- Фон: тёмный градиент `#0b1020 → #111a33`, лёгкое свечение `#37e0b0` в углу.
- Акценты: синий `#5b8cff` и мятный `#37e0b0` (как в логотипе/обложке).
- Логотип «novpn» — «no» белым, «vpn» синим `#5b8cff`.
- Без стоковых клише, без «хакера в капюшоне», без замочков‑эмодзи. Чисто, продукт‑лендинг.
- Скриншоты вставлять РЕАЛЬНЫЕ из `press/screenshots/` (не перерисовывать UI).

---

## 1. Обложка Habr / OG (1200×630)

Композиция: слева — вордмарк «novpn» крупно и подзаголовок «Своя панель для AmneziaWG и Xray ·
пользователь сам выдаёт себе ключ». Справа — макет **ноутбука** с реальным скриншотом
`admin-dashboard-dark-desktop.png` на экране, чуть развёрнут в 3/4. Тёмный градиентный фон,
мятное свечение справа‑сверху. Внизу мелким моно — `github.com/DanT2000/NoVPN`.

> Prompt: "Clean dark product hero, 1200x630. Left: large wordmark 'novpn' (no = white, vpn =
> #5b8cff) and subtitle. Right: a modern laptop mockup at slight 3/4 angle showing the provided
> dark dashboard screenshot on screen. Background gradient #0b1020→#111a33 with a soft #37e0b0
> glow top-right. Minimal, premium SaaS landing style, no clutter."

## 2. Hero «десктоп + телефон» (для шапки статьи, 1600×900)

Ноутбук с `admin-dashboard-dark-desktop.png` + перед ним смартфон с `admin-dashboard-mobile.png`
(показать адаптивность). Оба на тёмном градиенте, мягкие тени, отражение под устройствами.

> Prompt: "Dark scene, laptop showing the dashboard screenshot with a smartphone in front showing
> the mobile screenshot, soft shadows and floor reflection, gradient background #0b1020→#111a33,
> accent glow #37e0b0. Product marketing shot, photorealistic device mockups, screens = provided
> images unchanged."

## 3. Коллаж возможностей (1600×1000)

Три «карточки»‑экрана внахлёст: `admin-dashboard-dark-desktop.png` (графики/аптайм),
`admin-servers-desktop.png` (серверы), `admin-logs-desktop.png` (логи). Подписи‑чипы под каждым:
«Графики и аптайм», «Установка по SSH», «Логи с объяснением». Тёмный фон, синие/мятные акценты.

> Prompt: "Overlapping browser-window cards showing three provided screenshots (dashboard, servers,
> logs), each with a small pill caption. Dark gradient background, blue/mint accents, subtle depth
> and shadows, clean tech-marketing collage, 1600x1000."

## 4. Телефон в руке (соцсети, 1080×1080)

Смартфон с `public-home-mobile.png` (вход пользователя) крупно, тёмный фон, вордмарк сверху.
Подпись: «Одна ссылка — и человек сам выдаёт себе ключ».

> Prompt: "Square 1080x1080, a smartphone held showing the provided user-login screenshot, dark
> gradient background, 'novpn' wordmark top, short tagline, premium minimal, mint glow."

---

## Как собрать (примерно)

```bash
# пример вызова Codex CLI для генерации по брифу №1
codex image --prompt "$(sed -n '/## 1./,/## 2./p' press/image-briefs.md)" \
  --ref press/screenshots/admin-dashboard-dark-desktop.png \
  --out press/hero-cover.png --size 1200x630
```

Точную команду подставьте под свой Codex CLI. Если он не умеет вставлять реальный скрин в макет —
сгенерируйте пустой макет устройства по брифу, а скриншот наложите в редакторе (Figma/Photopea):
экран устройства → вставить PNG из `press/screenshots/`.
