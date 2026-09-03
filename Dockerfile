# auscii-deploy — images du pilote. Deux cibles depuis le même build :
#   docker build --target app    -t auscii-deploy-app .
#   docker build --target worker -t auscii-deploy-worker .
# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

# ---------- Dépendances (couche mise en cache tant que le lockfile ne bouge pas) ----------
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# ---------- Build de l'application ----------
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Valeurs factices : le build ne se connecte à rien, il a seulement besoin d'un
# environnement qui passe la validation de src/server/env.ts.
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
    useradd --system --uid 1001 --gid auscii auscii
COPY --from=builder --chown=auscii:auscii /app/.next/standalone ./
COPY --from=builder --chown=auscii:auscii /app/.next/static ./.next/static
COPY --from=builder --chown=auscii:auscii /app/public ./public
# Le client Prisma et son moteur ne sont pas toujours tracés par le build autonome.
COPY --from=builder --chown=auscii:auscii /app/node_modules/.prisma/client ./node_modules/.prisma/client
USER auscii
EXPOSE 3000
CMD ["node", "server.js"]

# ---------- Worker (jobs pg-boss) ----------
# Porte le binaire git (pousses GitHub) et Chromium (captures d'écran).
FROM base AS worker
ENV NODE_ENV=production \
    PLAYWRIGHT_CHROMIUM_PATH=/usr/bin/chromium
RUN apt-get update && \
    apt-get install -y --no-install-recommends git chromium fonts-liberation ca-certificates && \
    rm -rf /var/lib/apt/lists/*
RUN groupadd --system --gid 1001 auscii && \
    useradd --system --uid 1001 --gid auscii --create-home auscii
COPY --from=deps --chown=auscii:auscii /app/node_modules ./node_modules
COPY --chown=auscii:auscii package.json pnpm-lock.yaml tsconfig.json ./
COPY --chown=auscii:auscii prisma ./prisma
COPY --chown=auscii:auscii src ./src
RUN pnpm exec prisma generate
USER auscii
CMD ["pnpm", "exec", "tsx", "src/worker/index.ts"]
