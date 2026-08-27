# NoVPN manager (control plane + собранный фронтенд). Один контейнер, порт 3000.
# Контекст сборки — корень репозитория. Coolify: Dockerfile location = deploy/manager.Dockerfile.

# Базовый образ через зеркало Docker Hub от Google (mirror.gcr.io). На одном из
# build-хостов (107_AppsServer) путь к auth.docker.io по IPv6 перехватывается
# (на HTTPS-запрос приходит HTTP), и pull с docker.io падает «server gave HTTP
# response to HTTPS client». mirror.gcr.io отдаёт тот же образ в обход. Переопределяется
# build-arg'ом NODE_IMAGE, если понадобится вернуть docker.io.
ARG NODE_IMAGE=mirror.gcr.io/library/node:20-bookworm-slim

# Зеркало пакетов Debian. С прод-build-хоста (107_AppsServer) deb.debian.org (Fastly)
# недоступен: по IPv6 «network unreachable», по IPv4 connect timeout — из-за этого
# apt-get валил сборку с «Unable to locate package». mirror.yandex.ru с этого хоста
# доступен (TLS-рукопожатие проходит), но ИМЕННО HTTP: в node:*-slim нет
# ca-certificates (базовый образ их purge'ит), поэтому https-источник падает с
# «No system certificates available». Подписи пакетов всё равно проверяются по
# debian-archive-keyring. Откат — build-arg DEBIAN_MIRROR.
ARG DEBIAN_MIRROR=http://mirror.yandex.ru

# ---- build ----
FROM ${NODE_IMAGE} AS build
ARG DEBIAN_MIRROR
WORKDIR /app

# apt: IPv6 на build-хосте нерабочий — форсируем IPv4 и переключаем на зеркало
# (bookworm-slim хранит источники в deb822-файле, старый sources.list — на всякий).
RUN set -eux; \
    printf 'Acquire::ForceIPv4 "true";\n' > /etc/apt/apt.conf.d/99force-ipv4; \
    for f in /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list; do \
      [ -f "$f" ] && sed -i \
        -e "s#https\?://deb.debian.org/debian-security#${DEBIAN_MIRROR}/debian-security#g" \
        -e "s#https\?://deb.debian.org/debian#${DEBIAN_MIRROR}/debian#g" "$f" || true; \
    done

# инструменты сборки нативных модулей (better-sqlite3) — на случай, если
# prebuilt-бинарь недоступен и нужна компиляция из исходников. Не роняем сборку,
# если зеркало недоступно: при наличии prebuilt-бинаря компилятор не понадобится.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 || echo "ВНИМАНИЕ: apt недоступен — собираем без компилятора (нужен prebuilt better-sqlite3)"

# сначала манифесты — для кэша слоёв
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
COPY apps/manager/package.json apps/manager/
COPY apps/agent/package.json apps/agent/
# Зеркало npm (registry.npmmirror.com, Alibaba — НЕ Cloudflare). На build-хосте
# 107_AppsServer исходящий HTTPS к сервисам за Cloudflare перехватывается (на HTTPS
# приходит HTTP), а registry.npmjs.org фронтится Cloudflare — npm не мог докачать
# пакеты и падал «Exit handler never called!». Зеркало отдаёт те же пакеты в обход.
# Переписываем и resolved-URL в lock (иначе тарболы всё равно тянулись бы с npmjs.org).
# --no-audit/--no-fund — не ходить в Cloudflare-эндпоинты аудита. Откат — build-arg NPM_REGISTRY.
# better-sqlite3 ставится скриптом «prebuild-install || node-gyp rebuild», и обе ветки
# ходили мимо зеркал: prebuild-install — на github.com (Request timed out), node-gyp —
# за заголовками на nodejs.org (тоже таймаут); оба хоста с прод-build-хоста недоступны.
# Переводим на то же зеркало Alibaba, откуда уже успешно тянутся npm-пакеты:
#   binary_host → …/v11.10.0/better-sqlite3-v11.10.0-node-v115-linux-x64.tar.gz (готовый бинарь),
#   disturl     → заголовки node, если всё же придётся компилировать из исходников.
ENV npm_config_registry=https://registry.npmmirror.com \
    npm_config_audit=false \
    npm_config_fund=false \
    npm_config_better_sqlite3_binary_host=https://registry.npmmirror.com/-/binary/better-sqlite3 \
    npm_config_disturl=https://cdn.npmmirror.com/binaries/node
RUN sed -i 's#registry\.npmjs\.org#registry.npmmirror.com#g' package-lock.json 2>/dev/null || true
# --include=dev обязателен: Coolify задаёт NODE_ENV=production, иначе devDeps
# (typescript, vite) не установятся и сборка упадёт с «tsc: not found».
RUN npm install --include=dev --no-audit --no-fund

# исходники и сборка: shared → web → manager
COPY packages/shared packages/shared
COPY apps/web apps/web
COPY apps/manager apps/manager
RUN npm run build --workspace packages/shared \
 && npm run build --workspace apps/web \
 && npm run build --workspace apps/manager

# ---- runtime ----
FROM ${NODE_IMAGE} AS runtime
ARG DEBIAN_MIRROR
WORKDIR /app
# curl нужен healthcheck'у Coolify (он вызывает curl/wget внутри контейнера).
# В node:*-slim curl уже есть — лезем в apt только если его вдруг нет, иначе
# недоступность репозиториев с build-хоста роняет сборку на пустом месте.
RUN set -eux; \
    if ! command -v curl >/dev/null 2>&1; then \
      printf 'Acquire::ForceIPv4 "true";\n' > /etc/apt/apt.conf.d/99force-ipv4; \
      for f in /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list; do \
        [ -f "$f" ] && sed -i \
          -e "s#https\?://deb.debian.org/debian-security#${DEBIAN_MIRROR}/debian-security#g" \
          -e "s#https\?://deb.debian.org/debian#${DEBIAN_MIRROR}/debian#g" "$f" || true; \
      done; \
      apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/* || true; \
    fi; \
    command -v curl >/dev/null 2>&1 && curl --version | head -n1 \
      || echo "ВНИМАНИЕ: curl отсутствует — healthcheck работает через node (см. HEALTHCHECK ниже)"
ENV NODE_ENV=production \
    PORT=3000 \
    WEB_DIST=/app/apps/web/dist \
    DESKTOP_SEED_DIR=/app/desktop \
    DATABASE_PATH=/data/database.sqlite

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/apps/manager/package.json ./apps/manager/package.json
COPY --from=build /app/apps/manager/dist ./apps/manager/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
# Канал раздачи NoVPN Desktop (манифест + установщик + гайд) — из контекста сборки.
COPY desktop ./desktop

# том для БД (Coolify монтирует persistent storage на /data)
VOLUME ["/data"]
EXPOSE 3000

# healthcheck на /healthz
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/manager/dist/index.js"]
