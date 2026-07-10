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

## Порядок для dev-установки (localhost)

1. Проект/environment для NoVPN на сервере `localhost`.
2. Приложение из репозитория `0VPN`, ветка `develop`, build = Dockerfile
   (`deploy/manager.Dockerfile`).
3. FQDN `https://vpn.dev.appswire.ru`, порт 3000, healthcheck `/healthz`.
4. Отдельная БД (volume), отдельные секреты.
5. Deploy → дождаться выпуска сертификата.
6. Подключить первый тестовый VPN-сервер (см. [MIGRATION.md](MIGRATION.md)).

## Порядок для основной установки (apps)

Только после проверки dev и подготовки production-кандидата. Безопасная замена
существующего `NoVPN` — см. [MIGRATION.md](MIGRATION.md) (backup → rehearsal →
временный адрес → переключение FQDN → сохранение старой версии для rollback).
