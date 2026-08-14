#!/usr/bin/env bash
# NoVPN — установка в одну команду. Ставит Docker (если нужно), собирает и поднимает
# панель. Никаких переменных окружения задавать не нужно — секреты панель заведёт сама.
#
#   curl -fsSL https://raw.githubusercontent.com/DanT2000/0VPN/main/install.sh | sudo bash
#
# Переменные (необязательно):
#   PORT=8088   — порт панели на хосте (по умолчанию 3000; поменяйте, если занят,
#                 например когда ставите на тот же сервер, где уже крутится VPN).
#   DIR=/opt/novpn                 — куда клонировать (по умолчанию /opt/novpn).
#   REPO=https://github.com/DanT2000/0VPN  — источник.
set -euo pipefail

REPO="${REPO:-https://github.com/DanT2000/0VPN}"
DIR="${DIR:-/opt/novpn}"
PORT="${PORT:-3000}"

log()  { printf '\033[1;36m[NoVPN]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[NoVPN] ОШИБКА:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "Запустите от root (или через sudo)."

# --- зависимости: git, docker, docker compose ---
if ! command -v git >/dev/null 2>&1; then
  log "Ставлю git…"
  (apt-get update -qq && apt-get install -y -qq git) >/dev/null 2>&1 \
    || yum install -y git >/dev/null 2>&1 \
    || die "Не удалось поставить git — установите вручную и повторите."
fi

if ! command -v docker >/dev/null 2>&1; then
  log "Ставлю Docker (официальный скрипт get.docker.com)…"
  curl -fsSL https://get.docker.com | sh >/dev/null 2>&1 || die "Не удалось установить Docker."
  systemctl enable --now docker >/dev/null 2>&1 || true
fi

# compose v2 (плагин) или v1 (бинарь) — подбираем доступный.
if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  die "Не найден docker compose. Обновите Docker до версии с плагином compose."
fi

# --- проверка порта: не молча падать на занятом ---
if ss -tuln 2>/dev/null | grep -qE "[:.]${PORT}\b"; then
  die "Порт ${PORT} уже занят. Запустите с другим портом: PORT=8088 ... (см. шапку скрипта)."
fi

# --- код: клонируем или обновляем ---
if [ -d "$DIR/.git" ]; then
  log "Обновляю $DIR…"
  git -C "$DIR" pull --ff-only >/dev/null 2>&1 || die "git pull не удался в $DIR."
else
  log "Клонирую $REPO в $DIR…"
  git clone --depth 1 "$REPO" "$DIR" >/dev/null 2>&1 || die "git clone не удался."
fi

# --- сборка и запуск ---
cd "$DIR"
log "Собираю и запускаю панель (первый раз — несколько минут)…"
PORT="$PORT" $COMPOSE -f deploy/docker-compose.yml up -d --build

# --- итог ---
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
log "Готово! Панель поднята."
echo
echo "  Адрес:    http://${IP:-<IP-сервера>}:${PORT}"
echo "  Логин:    (пароль по умолчанию) admin"
echo "  Внимание: при первом входе панель заставит сменить пароль администратора."
echo
echo "  Логи:     cd $DIR && $COMPOSE -f deploy/docker-compose.yml logs -f manager"
echo "  Обновить: повторите эту команду (git pull + пересборка)."
echo
echo "  Дальше — войдите в панель и добавьте серверы (Xray / AmneziaWG / прокси)"
echo "  по SSH прямо из веб-интерфейса. ENV настраивать не нужно."
