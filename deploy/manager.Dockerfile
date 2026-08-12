# NoVPN manager (control plane + собранный фронтенд). Один контейнер, порт 3000.
# Контекст сборки — корень репозитория. Coolify: Dockerfile location = deploy/manager.Dockerfile.

# Базовый образ через зеркало Docker Hub от Google (mirror.gcr.io). На одном из
# build-хостов (107_AppsServer) путь к auth.docker.io по IPv6 перехватывается
# (на HTTPS-запрос приходит HTTP), и pull с docker.io падает «server gave HTTP
# response to HTTPS client». mirror.gcr.io отдаёт тот же образ в обход. Переопределяется
# build-arg'ом NODE_IMAGE, если понадобится вернуть docker.io.
ARG NODE_IMAGE=mirror.gcr.io/library/node:20-bookworm-slim

# ---- build ----
FROM ${NODE_IMAGE} AS build
WORKDIR /app

# инструменты сборки нативных модулей (better-sqlite3) — на случай, если
# prebuilt-бинарь недоступен и нужна компиляция из исходников.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# сначала манифесты — для кэша слоёв
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
COPY apps/manager/package.json apps/manager/
COPY apps/agent/package.json apps/agent/
# --include=dev обязателен: Coolify задаёт NODE_ENV=production, иначе devDeps
# (typescript, vite) не установятся и сборка упадёт с «tsc: not found».
# Флаги снижают пик памяти: build-хост 107_AppsServer — 2 ГБ RAM с почти полным
# свопом, и обычный npm install падал OOM («Exit handler never called!»).
# jobs=1 — последовательная сборка нативных модулей; без audit/fund; меньше сокетов.
ENV npm_config_jobs=1 npm_config_audit=false npm_config_fund=false
RUN npm install --include=dev --no-audit --no-fund --maxsockets=4

# исходники и сборка: shared → web → manager
COPY packages/shared packages/shared
COPY apps/web apps/web
COPY apps/manager apps/manager
RUN npm run build --workspace packages/shared \
 && npm run build --workspace apps/web \
 && npm run build --workspace apps/manager

# ---- runtime ----
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
# curl нужен healthcheck'у Coolify (он вызывает curl/wget внутри контейнера)
RUN apt-get update && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PORT=3000 \
    WEB_DIST=/app/apps/web/dist \
    DATABASE_PATH=/data/database.sqlite

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/apps/manager/package.json ./apps/manager/package.json
COPY --from=build /app/apps/manager/dist ./apps/manager/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist

# том для БД (Coolify монтирует persistent storage на /data)
VOLUME ["/data"]
EXPOSE 3000

# healthcheck на /healthz
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/manager/dist/index.js"]
