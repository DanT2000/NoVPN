# NoVPN manager (control plane + собранный фронтенд). Один контейнер, порт 3000.
# Контекст сборки — корень репозитория. Coolify: Dockerfile location = deploy/manager.Dockerfile.

# ---- build ----
FROM node:20-bookworm-slim AS build
WORKDIR /app

# сначала манифесты — для кэша слоёв
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
COPY apps/manager/package.json apps/manager/
COPY apps/agent/package.json apps/agent/
RUN npm install

# исходники и сборка: shared → web → manager
COPY packages/shared packages/shared
COPY apps/web apps/web
COPY apps/manager apps/manager
RUN npm run build --workspace packages/shared \
 && npm run build --workspace apps/web \
 && npm run build --workspace apps/manager

# ---- runtime ----
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
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
