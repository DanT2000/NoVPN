#!/usr/bin/env bash
# NoVPN — установка VPN-сервера (AmneziaWG + Xray Reality) + агент.
# Идемпотентно. Поддерживает ВОССТАНОВЛЕНИЕ серверных ключей по домену:
# если передать сохранённые ключи (env AWG_SERVER_PRIVKEY / XRAY_REALITY_PRIVKEY),
# старые клиентские конфиги продолжат работать на новом сервере (тот же домен → те же ключи).
#
# Запуск (панель подставляет значения):
#   CONTROL_PLANE_URL=https://vpn.example.com \
#   ENROLLMENT_TOKEN=... \
#   PUBLIC_HOST=fi1.example.com \
#   [AWG_SERVER_PRIVKEY=... XRAY_REALITY_PRIVKEY=... XRAY_SHORT_ID=... XRAY_SNI=...] \
#   bash novpn-server-install.sh
set -euo pipefail

CONTROL_PLANE_URL="${CONTROL_PLANE_URL:?CONTROL_PLANE_URL обязателен}"
ENROLLMENT_TOKEN="${ENROLLMENT_TOKEN:?ENROLLMENT_TOKEN обязателен}"
PUBLIC_HOST="${PUBLIC_HOST:?PUBLIC_HOST (домен или IP) обязателен}"

AWG_CONTAINER="${AWG_CONTAINER:-amnezia-awg2}"
XRAY_CONTAINER="${XRAY_CONTAINER:-amnezia-xray}"
AGENT_CONTAINER="${AGENT_CONTAINER:-novpn-agent}"
AWG_PORT="${AWG_PORT:-51820}"
XRAY_PORT="${XRAY_PORT:-443}"
AWG_SUBNET="${AWG_SUBNET:-10.8.1}"
XRAY_SNI="${XRAY_SNI:-www.microsoft.com}"
DATA_DIR="${DATA_DIR:-/opt/novpn}"
AWG_DIR="/opt/amnezia/awg"
XRAY_DIR="/opt/amnezia/xray"

log() { echo "→ $*"; }

# ── 1. Docker ──────────────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  log "Устанавливаю Docker…"
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker >/dev/null 2>&1 || true

# ── 2. Ядро/форвардинг/NAT (обязательно для маршрутизации VPN) ─────────────
log "Включаю ip_forward и NAT…"
sysctl -w net.ipv4.ip_forward=1 >/dev/null
grep -q '^net.ipv4.ip_forward=1' /etc/sysctl.conf || echo 'net.ipv4.ip_forward=1' >> /etc/sysctl.conf
WAN_IF="$(ip route show default | awk '/default/ {print $5; exit}')"
if ! iptables -t nat -C POSTROUTING -s "${AWG_SUBNET}.0/24" -o "$WAN_IF" -j MASQUERADE 2>/dev/null; then
  iptables -t nat -A POSTROUTING -s "${AWG_SUBNET}.0/24" -o "$WAN_IF" -j MASQUERADE
fi

# ── 3. AmneziaWG ───────────────────────────────────────────────────────────
mkdir -p "$AWG_DIR"
if [ -n "${AWG_SERVER_PRIVKEY:-}" ]; then
  log "AmneziaWG: восстанавливаю серверный ключ (домен сохранён)…"
  SRV_PRIV="$AWG_SERVER_PRIVKEY"
else
  log "AmneziaWG: генерирую новый серверный ключ…"
  SRV_PRIV="$(docker run --rm amneziavpn/amnezia-wg:latest awg genkey 2>/dev/null || wg genkey)"
fi
if [ ! -f "$AWG_DIR/awg0.conf" ] || [ -n "${AWG_SERVER_PRIVKEY:-}" ]; then
  cat > "$AWG_DIR/awg0.conf" <<EOF
[Interface]
Address = ${AWG_SUBNET}.1/24
ListenPort = ${AWG_PORT}
PrivateKey = ${SRV_PRIV}
Jc = 4
Jmin = 40
Jmax = 70
S1 = 86
S2 = 97
H1 = 1004746675
H2 = 928473625
H3 = 1719083348
H4 = 1339303396
EOF
fi
if ! docker ps --format '{{.Names}}' | grep -qx "$AWG_CONTAINER"; then
  log "AmneziaWG: запускаю контейнер…"
  docker rm -f "$AWG_CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$AWG_CONTAINER" --restart unless-stopped \
    --cap-add NET_ADMIN --cap-add SYS_MODULE \
    -e AWG_PORT="$AWG_PORT" \
    -p "${AWG_PORT}:${AWG_PORT}/udp" \
    -v "$AWG_DIR:/opt/amnezia/awg" \
    amneziavpn/amnezia-wg:latest >/dev/null || \
    log "ВНИМАНИЕ: образ AmneziaWG недоступен — установи стек Amnezia или укажи AWG_IMAGE."
fi

# ── 4. Xray Reality ────────────────────────────────────────────────────────
mkdir -p "$XRAY_DIR"
if [ -n "${XRAY_REALITY_PRIVKEY:-}" ]; then
  log "Xray: восстанавливаю reality-ключ (домен сохранён)…"
  X_PRIV="$XRAY_REALITY_PRIVKEY"
  X_SID="${XRAY_SHORT_ID:-$(openssl rand -hex 8)}"
else
  log "Xray: генерирую reality-ключ…"
  KP="$(docker run --rm teddysun/xray xray x25519 2>/dev/null || true)"
  X_PRIV="$(echo "$KP" | awk -F': ' '/Private/{print $2}')"
  X_SID="$(openssl rand -hex 8)"
fi
if [ ! -f "$XRAY_DIR/server.json" ] || [ -n "${XRAY_REALITY_PRIVKEY:-}" ]; then
  cat > "$XRAY_DIR/server.json" <<EOF
{
  "inbounds": [{
    "listen": "0.0.0.0", "port": ${XRAY_PORT}, "protocol": "vless",
    "settings": { "clients": [], "decryption": "none" },
    "streamSettings": {
      "network": "tcp", "security": "reality",
      "realitySettings": {
        "show": false, "dest": "${XRAY_SNI}:443", "xver": 0,
        "serverNames": ["${XRAY_SNI}"], "privateKey": "${X_PRIV}",
        "shortIds": ["${X_SID}"]
      }
    }
  }],
  "outbounds": [{ "protocol": "freedom" }]
}
EOF
fi
if ! docker ps --format '{{.Names}}' | grep -qx "$XRAY_CONTAINER"; then
  log "Xray: запускаю контейнер…"
  docker rm -f "$XRAY_CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$XRAY_CONTAINER" --restart unless-stopped \
    -p "${XRAY_PORT}:${XRAY_PORT}" \
    -v "$XRAY_DIR/server.json:/etc/xray/config.json" \
    teddysun/xray -config /etc/xray/config.json >/dev/null || \
    log "ВНИМАНИЕ: образ Xray недоступен — укажи XRAY_IMAGE."
fi

# ── 5. NoVPN Agent (исходящее соединение к панели) ─────────────────────────
mkdir -p "$DATA_DIR/agent"
log "Запускаю NoVPN Agent…"
docker rm -f "$AGENT_CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$AGENT_CONTAINER" --restart unless-stopped \
  -e CONTROL_PLANE_URL="$CONTROL_PLANE_URL" \
  -e AGENT_ENROLLMENT_TOKEN="$ENROLLMENT_TOKEN" \
  -e AGENT_DATA_DIR=/var/lib/novpn-agent \
  -e AMNEZIAWG_ENDPOINT_HOST="$PUBLIC_HOST" \
  -e XRAY_ENDPOINT_HOST="$PUBLIC_HOST" \
  -e AMNEZIAWG_CONTAINER="$AWG_CONTAINER" \
  -e XRAY_CONTAINER="$XRAY_CONTAINER" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$DATA_DIR/agent:/var/lib/novpn-agent" \
  "${NOVPN_AGENT_IMAGE:-ghcr.io/dant2000/novpn-agent:latest}" >/dev/null || \
  log "ВНИМАНИЕ: образ агента недоступен — задай NOVPN_AGENT_IMAGE."

log "Готово. Публичные ключи (для панели):"
echo "AWG_SERVER_PUBKEY=$(echo "$SRV_PRIV" | (docker run --rm -i amneziavpn/amnezia-wg:latest awg pubkey 2>/dev/null || wg pubkey))"
echo "XRAY_REALITY_PRIVKEY_SAVED=1 XRAY_SHORT_ID=${X_SID} XRAY_SNI=${XRAY_SNI}"
