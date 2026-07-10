# Локальный запуск

## Требования

- Node.js ≥ 20, npm ≥ 10
- (опционально) Docker — для сборки образов и запуска агента локально

## Установка

```bash
npm install
cp .env.example .env
```

Заполните `.env` (см. комментарии). Минимум для запуска панели:

```
NODE_ENV=development
PORT=3000
APP_NAME=NoVPN
PUBLIC_URL=http://localhost:3000
ADMIN_LOGIN=admin
ADMIN_PASSWORD=<любой для локалки>
SESSION_SECRET=<случайная строка>
ENCRYPTION_KEY=<32 байта, base64>
DATABASE_PATH=./apps/manager/data/database.sqlite
ENABLE_MOCK_AGENT=true
```

Сгенерировать `ENCRYPTION_KEY` и `SESSION_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

## Запуск

```bash
npm run dev
```

- Фронтенд (Vite, HMR): http://localhost:5173
- API / панель: http://localhost:3000

### Только фронтенд на mock-данных (без backend)

Установите в `.env` веб-приложения `VITE_USE_MOCK=true` — весь UI работает на
mock-адаптере (`apps/web/src/api/mock`). Компоненты не знают, mock это или
реальный API: они зависят только от интерфейса `NoVpnApi` из `@novpn/shared`.

## Полезные команды

```bash
npm run build        # собрать всё (shared → web → manager → agent)
npm run typecheck    # проверка типов во всех воркспейсах
npm run test         # тесты
npm run dev:agent    # запустить агент отдельно
```

## Структура портов (локально)

| Сервис | Порт |
|--------|------|
| web (Vite dev) | 5173 |
| manager (API) | 3000 |
| agent (health) | 9090 |
