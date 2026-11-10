# syntax=docker/dockerfile:1
#
# Image of the application (copy of templates/app). Not built or run by its author: the first `docker build`
# is the real test. Things to check on it: the Node tag exists on Docker Hub; argon2 and sharp load on this
# base; package-lock.json is committed (without one `npm install` is not reproducible).
ARG NODE_VERSION=26
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi \
 && npm install-scripts approve argon2 \
 && npm rebuild argon2

FROM node:${NODE_VERSION}-bookworm-slim
ENV NODE_ENV=production \
    DAS_ENV=production \
    UV_THREADPOOL_SIZE=8 \
    DAS_HOST=0.0.0.0 \
    DAS_PORT=9902 \
    DAS_HTTPS_MODE=reverse-proxy \
    DAS_TRUST_PROXY=true \
    DAS_DB_FILE=data/my-app.db
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json app.config.js ./
COPY bin ./bin
COPY src ./src
COPY migrations ./migrations
COPY assets ./assets
# Everything the application writes (database, backups, uploads, certificates) lives under data: mount ONE volume there.
RUN mkdir -p data && chown -R node:node data
VOLUME ["/app/data"]
USER node
EXPOSE 9902
STOPSIGNAL SIGTERM
# /health answers 503 as soon as shutdown starts, so orchestrators stop routing early.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.DAS_PORT||9902)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]
