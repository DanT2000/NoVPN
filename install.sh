#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════
#  NoVPN — установка/обновление панели одной командой.
#  Использование:   cp .env.example .env   &&   ./install.sh
#  Скрипт сам проверит зависимости, досоздаст секреты, соберёт и
#  запустит панель в Docker, дождётся готовности и покажет адрес.
# ══════════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")"

COMPOSE_FILE="deploy/docker-compose.yml"
red() { printf '\033[31m%s\033[0m\n' "$1"; }
grn() { printf '\033[32m%s\033[0m\n' "$1"; }
ylw() { printf '\033[33m%s\033[0m\n' "$1"; }

# 1) Проверка зависимостей ──────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  red "Не найден Docker. Установите Docker: https://docs.docker.com/engine/install/"
  exit 1
fi
if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  red "Не найден docker compose (плагин или docker-compose). Установите Docker Compose v2."
  exit 1
fi

# 2) .env ───────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  ylw ".env не найден — создаю из .env.example. Отредактируйте PUBLIC_URL после установки."
  cp .env.example .env
fi

# Дописать переменную в .env, если она пустая или отсутствует.
gen_secret() { openssl rand -hex 32 2>/dev/null || head -c32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
ensure_secret() { # $1 = имя переменной
  local name="$1" val
  val="$(grep -E "^${name}=" .env | head -1 | cut -d= -f2- || true)"
  if [ -z "${val}" ]; then
    local secret; secret="$(gen_secret)"
    if grep -qE "^${name}=" .env; then
      # заменить пустое значение (portable sed)
      tmp="$(mktemp)"; awk -v n="$name" -v s="$secret" 'BEGIN{FS=OFS="="} $1==n{print n"="s; next} {print}' .env > "$tmp" && mv "$tmp" .env
    else
      printf '%s=%s\n' "$name" "$secret" >> .env
    fi
    grn "Сгенерирован ${name} (записан в .env)."
  fi
}
ensure_secret ENCRYPTION_KEY
ensure_secret SESSION_SECRET

# Предупредить, если публичный адрес не задан осмысленно.
PUB="$(grep -E '^PUBLIC_URL=' .env | head -1 | cut -d= -f2- || true)"
if [ -z "${PUB}" ] || printf '%s' "$PUB" | grep -q 'panel.example.com'; then
  ylw "PUBLIC_URL не задан (или пример). Панель поднимется, но задайте реальный адрес"
  ylw "в .env (PUBLIC_URL=https://ваш.домен) или в панели: Настройки → Адрес сайта."
fi

# 3) Сборка и запуск ────────────────────────────────────────────────
# --env-file указываем явно: compose иначе ищет .env рядом с compose-файлом
# (в deploy/), а он лежит в корне проекта.
grn "Собираю и запускаю панель (${DC})…"
$DC --env-file .env -f "$COMPOSE_FILE" up -d --build

# 4) Ожидание готовности ────────────────────────────────────────────
PORT="$(grep -E '^PORT=' .env | head -1 | cut -d= -f2- || true)"; PORT="${PORT:-3000}"
printf 'Жду готовности'
for i in $(seq 1 30); do
  if curl -fsS "http://localhost:${PORT}/healthz" >/dev/null 2>&1; then
    echo; grn "Готово. Панель отвечает на порту ${PORT}."
    echo "Откройте:  ${PUB:-http://localhost:${PORT}}"
    echo "Первый вход — паролем администратора (по умолчанию «admin»), затем смените его."
    exit 0
  fi
  printf '.'; sleep 2
done
echo
red "Панель не ответила на /healthz за отведённое время. Проверьте логи:"
echo "  $DC --env-file .env -f $COMPOSE_FILE logs --tail=50 manager"
exit 1
