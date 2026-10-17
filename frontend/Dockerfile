# syntax=docker/dockerfile:1
#
# The public entrypoint: Caddy serving the built SPA and reverse-proxying /api to the backend,
# with automatic HTTPS. Build context is the repo root:
#   docker build -f frontend/Dockerfile .

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci --workspace frontend
COPY frontend/ frontend/
# Same-origin API path: Caddy strips /api before proxying, so no CORS and the refresh cookie
# (path "/") just works. Baked in at build time — Vite inlines VITE_* vars.
ARG VITE_API_URL=/api
ENV VITE_API_URL=${VITE_API_URL}
RUN npm run build --workspace frontend

FROM caddy:2.8.4-alpine
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/frontend/dist /srv
