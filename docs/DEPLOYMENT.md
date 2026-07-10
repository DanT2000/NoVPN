# Развёртывание (Coolify)

Две **независимые** установки одного кода. Ничего общего между ними (БД, тома,
ключи, сессии, токены, пользователи, статистика).

| | Dev / отдельная | Основная |
|---|---|---|
| Ветка | `develop` | `main` (зафиксированный commit / release) |
| Сервер Coolify | `localhost` | `apps` (107_AppsServer) |
| Домен | https://vpn.dev.appswire.ru | https://vpn.appswire.ru |
| Владелец | другой (коллега) | владелец проекта |

## Общий образ

`apps/manager` собирается из `deploy/manager.Dockerfile` (multi-stage):
собирает `packages/shared` → `apps/web` (статика) → `apps/manager` и запускает
Node-сервер, который отдаёт и API, и собранный фронтенд на одном порту `3000`.

`apps/agent` собирается из `deploy/agent.Dockerfile` и ставится на VPN-сервер
(через мастер добавления сервера или вручную одноразовой командой).

## Переменные окружения (задаются в Coolify, НЕ в Git)

Панель (`apps/manager`), см. `.env.example`:
`NODE_ENV, PORT=3000, APP_NAME=NoVPN, PUBLIC_URL, ADMIN_LOGIN, ADMIN_PASSWORD,
SESSION_SECRET, ENCRYPTION_KEY, DATABASE_PATH, CONTENT_DIR,
AGENT_ENROLLMENT_TTL_MIN` (+ на время миграции `VPN_AGENT_URL, VPN_AGENT_TOKEN,
ENABLE_MOCK_AGENT`).

- `SESSION_SECRET`, `ENCRYPTION_KEY` — **у каждой установки свои** (изоляция).
- `DATABASE_PATH` указывает на persistent volume (напр. `/data/database.sqlite`).

## SSL и маршрутизация

Coolify использует встроенный прокси (Traefik/Caddy) с автоматическим
Let's Encrypt. Достаточно задать **FQDN** приложения (`https://vpn.dev.appswire.ru`
/ `https://vpn.appswire.ru`) — сертификат выпускается автоматически, как у уже
работающих проектов `*.appswire.ru`. Ручную схему SSL создавать не нужно.

## Healthcheck

Панель отдаёт `GET /healthz` → `200 {"status":"ok"}`. В Coolify включить
healthcheck на `/healthz`, порт `3000`.

## Persistent storage

Смонтировать том на каталог с БД (`DATABASE_PATH`) и, при необходимости,
на `CONTENT_DIR` (markdown-инструкции/сниппеты). Тома **не** общие между dev и prod.

## Предусловие (действие владельца)

Репозиторий `0VPN` приватный. Чтобы Coolify мог его собрать, GitHub App Coolify
должен иметь доступ к `DanT2000/0VPN`:
GitHub → Settings → Applications → (Coolify) → Repository access → добавить `0VPN`.
Тот же GitHub App уже используется для `ZeroVPN`.

## Порядок для dev-установки (Coolify, сервер `localhost`)

1. Новый проект `NoVPN_dev` (или environment) на сервере `localhost`.
2. **New Resource → Application → Private Repository (GitHub App)** → `DanT2000/0VPN`.
3. Настройки приложения:
   - Branch: `develop`
   - Build Pack: **Dockerfile**
   - Dockerfile Location: `deploy/manager.Dockerfile`
   - Base Directory: `/`
   - Ports Exposes: `3000`
   - Healthcheck: включить, path `/healthz`, port `3000`
4. Domains (FQDN): `https://vpn.dev.appswire.ru` → Coolify сам выпустит
   Let's Encrypt (как у других `*.dev.appswire.ru`).
5. Persistent Storage: том на `/data` (SQLite: `DATABASE_PATH=/data/database.sqlite`).
6. Environment variables (свои для dev, НЕ из prod):
   ```
   NODE_ENV=production
   PORT=3000
   APP_NAME=NoVPN
   PUBLIC_URL=https://vpn.dev.appswire.ru
   ADMIN_LOGIN=<логин>
   ADMIN_PASSWORD=<пароль>
   SESSION_SECRET=<openssl rand -base64 32>
   ENCRYPTION_KEY=<openssl rand -base64 32>   # 32 байта
   DATABASE_PATH=/data/database.sqlite
   ENABLE_MOCK_AGENT=true                      # пока не подключён реальный агент
   ```
7. Deploy из зафиксированного commit → дождаться сертификата → проверить `/healthz`.
8. Подключить тестовый VPN-сервер `185.9.26.133` и импортировать конфиги
   (см. [MIGRATION.md](MIGRATION.md)). На этом сервере: только AmneziaWG
   (контейнер `amnezia-awg2`, порт 40435, подсеть 10.8.1.x), Xray отсутствует.
   После enrollment агента переключить `ENABLE_MOCK_AGENT=false`.

## Порядок для основной установки (apps)

Только после проверки dev и подготовки production-кандидата. Безопасная замена
существующего `NoVPN` — см. [MIGRATION.md](MIGRATION.md) (backup → rehearsal →
временный адрес → переключение FQDN → сохранение старой версии для rollback).
