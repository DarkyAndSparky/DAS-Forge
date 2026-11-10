# syntax=docker/dockerfile:1
#
# DAS-Forge workshop (reference app) image.
#
# NOT BUILT OR RUN by its author - the development sandbox has no Docker and
# no network. Treat the first `docker build` as the real test. Known things
# to check on first build:
#   * the Node 26 tag below actually exists on Docker Hub (pin it to a digest
#     once it does);
#   * argon2 / sharp native binaries load on this base (glibc, Debian slim);
#     npm >= 11 may block argon2's install script: see the `install-scripts
#     approve` line;
#   * package-lock.json is committed (the build falls back to `npm install`
#     without one, which is NOT reproducible).

ARG NODE_VERSION=26
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/core/package.json packages/core/
COPY examples/workshop/package.json examples/workshop/
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi \
 && npm install-scripts approve argon2 \
 && npm rebuild argon2

FROM node:${NODE_VERSION}-bookworm-slim
ENV NODE_ENV=production \
    DAS_ENV=production \
    UV_THREADPOOL_SIZE=8 \
    DAS_HOST=0.0.0.0 \
    DAS_PORT=9002 \
    DAS_HTTPS_MODE=reverse-proxy \
    DAS_TRUST_PROXY=true \
    DAS_DB_FILE=data/workshop.db
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY packages ./packages
COPY examples ./examples
# Everything the app writes (database, backups, uploads, certs) lives under
# examples/workshop/data: mount ONE volume there.
RUN mkdir -p examples/workshop/data && chown -R node:node examples/workshop/data
VOLUME ["/app/examples/workshop/data"]
USER node
WORKDIR /app/examples/workshop
EXPOSE 9002
STOPSIGNAL SIGTERM
# /health answers 503 as soon as shutdown starts, so orchestrators stop routing early.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.DAS_PORT||9002)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]
