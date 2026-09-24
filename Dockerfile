# syntax=docker/dockerfile:1
# auscii-deploy — images du pilote. Trois cibles depuis le même contexte :
#   docker build --target app    -t auscii-deploy-app .
#   docker build --target worker -t auscii-deploy-worker .
#   docker build --target backup -t auscii-deploy-backup .
# Les images n'ont besoin ni de corepack ni de pnpm à l'exécution : tout est
# lancé avec node directement, sans accès réseau au démarrage.

FROM node:22.23-bookworm-slim AS base
# OpenSSL 3 : Prisma choisit son moteur d'après la libssl présente
# (debian-openssl-3.0.x, voir binaryTargets dans prisma/schema.prisma).
RUN apt-get update && \
    apt-get install -y --no-install-recommends openssl ca-certificates && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ---------- Outillage de build (pnpm via corepack, jamais dans les images finales) ----------
FROM base AS toolchain
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# ---------- Dépendances (couche mise en cache tant que le lockfile ne bouge pas) ----------
FROM toolchain AS deps
# pnpm-workspace.yaml porte onlyBuiltDependencies : sans lui, les scripts
# d'installation de Prisma (moteurs) seraient bloqués.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# ---------- Build de l'application ----------
FROM toolchain AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# public/ est vide et non suivi par git : la créer garantit que la copie
# vers l'image de l'application aboutit, avec ou sans fichier statique.
RUN mkdir -p public
# Valeurs factices : le build ne se connecte à rien, il a seulement besoin d'un
# environnement qui passe la validation de src/server/env.ts. PREVIEW_ORIGIN
# reste vide : Caddy complète la CSP à l'exécution (voir next.config.ts).
ENV NEXT_TELEMETRY_DISABLED=1 \
    DATABASE_URL=postgresql://build:build@localhost:5432/build \
    BETTER_AUTH_SECRET=build-only-secret-build-only-secret \
    APP_ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000
RUN pnpm build

# ---------- Application (Next.js autonome) ----------
FROM base AS app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
RUN groupadd --system --gid 1001 auscii && \
    useradd --system --uid 1001 --gid auscii auscii && \
    mkdir -p /data && chown auscii:auscii /data
COPY --from=builder --chown=auscii:auscii /app/.next/standalone ./
COPY --from=builder --chown=auscii:auscii /app/.next/static ./.next/static
COPY --from=builder --chown=auscii:auscii /app/public ./public
# Le client Prisma généré et son moteur natif (bibliothèque Node-API
# libquery_engine-debian-openssl-3.0.x.so.node, pas du WASM) sont tracés dans
# .next/standalone, sous node_modules/.pnpm/@prisma+client*/node_modules/.prisma/client.
USER auscii
EXPOSE 3000
CMD ["node", "server.js"]

# ---------- Worker (jobs pg-boss, migrations, compte admin) ----------
# Porte le binaire git (pousses GitHub) et Chromium (captures d'écran).
FROM base AS worker
ENV NODE_ENV=production \
    PLAYWRIGHT_CHROMIUM_PATH=/usr/bin/chromium
RUN apt-get update && \
    apt-get install -y --no-install-recommends git chromium fonts-liberation && \
    rm -rf /var/lib/apt/lists/*
RUN groupadd --system --gid 1001 auscii && \
    useradd --system --uid 1001 --gid auscii --create-home auscii && \
    mkdir -p /data && chown auscii:auscii /data
COPY --from=deps --chown=auscii:auscii /app/node_modules ./node_modules
COPY --chown=auscii:auscii package.json pnpm-lock.yaml tsconfig.json ./
COPY --chown=auscii:auscii prisma ./prisma
COPY --chown=auscii:auscii src ./src
RUN node node_modules/prisma/build/index.js generate
USER auscii
# tsx chargé comme hook de node : un seul processus, qui reçoit SIGTERM.
CMD ["node", "--import", "tsx", "src/worker/index.ts"]

# ---------- Sauvegardes (pg_dump, envoi chiffré vers Object Storage) ----------
# Même version de PostgreSQL que la base (docker-compose.yml du pilote).
FROM postgres:16.15-alpine AS backup
RUN apk add --no-cache aws-cli age tar curl tzdata
COPY --chmod=755 infra/pilot/backup.sh /usr/local/bin/backup.sh
ENTRYPOINT ["/usr/local/bin/backup.sh"]
CMD ["cron"]
