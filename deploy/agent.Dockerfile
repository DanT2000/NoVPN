# NoVPN Agent. Ставится на VPN-сервере. Нужен доступ к docker-сокету хоста
# (управляет контейнерами amnezia-xray / amnezia-awg2). Соединение с панелью —
# исходящее. Контекст сборки — корень репозитория.

# ---- build ----
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/agent/package.json apps/agent/
RUN npm install --workspace @novpn/agent --workspace @novpn/shared
COPY packages/shared packages/shared
COPY apps/agent apps/agent
RUN npm run build --workspace packages/shared \
 && npm run build --workspace apps/agent

# ---- runtime ----
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    AGENT_DATA_DIR=/var/lib/novpn-agent

# docker CLI (для exec в контейнеры amnezia); сокет хоста монтируется при запуске
COPY --from=docker:24-cli /usr/local/bin/docker /usr/local/bin/docker

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/apps/agent/package.json ./apps/agent/package.json
COPY --from=build /app/apps/agent/dist ./apps/agent/dist

VOLUME ["/var/lib/novpn-agent"]
EXPOSE 9090
CMD ["node", "apps/agent/dist/index.js"]
