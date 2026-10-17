# syntax=docker/dockerfile:1
#
# One image, three roles (chosen by the compose `command`):
#   API       node dist/index.js                (default)
#   OCR       node dist/worker/ocr.worker.js
#   migrate   npx prisma migrate deploy         (one-shot, before the API starts)
#
# Build context is the repo root (npm workspaces share one package-lock.json):
#   docker build -f backend/Dockerfile .

FROM node:22-bookworm-slim AS base
# openssl: Prisma's query engine links against it. ca-certificates: outbound TLS (R2, Brevo,
# tesseract.js language-data download).
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ── build: full dev toolchain, compile TypeScript ──────────────────────────────
FROM base AS build
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci --workspace backend
COPY backend/ backend/
RUN cd backend && npx prisma generate && npx tsc -p tsconfig.json

# ── runtime: production dependencies only ──────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci --workspace backend --omit=dev && npm cache clean --force
COPY backend/prisma backend/prisma
RUN cd backend && npx prisma generate
COPY --from=build /app/backend/dist backend/dist
# The OCR worker caches tesseract.js language data in its working directory on first use.
RUN chown node:node /app/backend
USER node
WORKDIR /app/backend
EXPOSE 4000
CMD ["node", "dist/index.js"]
