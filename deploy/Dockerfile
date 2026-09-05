# Multi-host shared Taskboard server (phase 1 skeleton).
# Build:  docker build -f deploy/Dockerfile -t <image> .
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web ./web
COPY shared ./shared
RUN npm run build:web

FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    CODEX_TASKBOARD_DATA_DIR=/data \
    CODEX_TASKBOARD_HOST=0.0.0.0 \
    CODEX_TASKBOARD_PORT=47823
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server ./server
COPY shared ./shared
COPY cli ./cli
COPY skills ./skills
COPY --from=build /app/dist/web ./dist/web
VOLUME /data
EXPOSE 47823
USER node
CMD ["node", "server/index.mjs"]
