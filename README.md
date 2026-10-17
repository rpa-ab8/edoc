# DMS — Document Management System

Universal, multi-sector Document Management System. See `CLAUDE.md` and `docs/` for full product
and architecture context.

## Stack

Node.js/Fastify backend, React/Vite frontend, PostgreSQL, Redis — see
`docs/DMS_Technology_Stack.md` for the full reasoning. This is an npm-workspaces monorepo:
`backend/` and `frontend/` are separate workspaces sharing one root `package.json` / lockfile.

## Prerequisites

- Node.js 20+ and npm
- Docker Desktop (or another Docker Compose–compatible runtime)

## First-time setup

```bash
npm install                      # installs both workspaces from the root
cp .env.example .env              # single shared .env, read by docker-compose, backend, and frontend
```

`backend/prisma/schema.prisma` must exist before the Prisma steps below — see
`backend/prisma/README.md`.

## Running everything locally

1. **Start Postgres + Redis:**

   ```bash
   npm run docker:up
   ```

2. **Apply migrations and generate the Prisma client** (requires `backend/prisma/schema.prisma`):

   ```bash
   npm run prisma:generate --workspace backend
   npm run prisma:migrate --workspace backend
   ```

   Browse the database with:

   ```bash
   npm run prisma:studio --workspace backend
   ```

3. **Start the backend** (Fastify, `http://localhost:4000`):

   ```bash
   npm run dev:backend
   ```

   Confirm it's up: `curl http://localhost:4000/health`

4. **Start the frontend** (Vite, `http://localhost:5173`):

   ```bash
   npm run dev:frontend
   ```

   The placeholder page calls the backend's `/health` endpoint and displays the result.

## Stopping

```bash
npm run docker:down
```

## Repo layout

```
backend/    Fastify + TypeScript API, Prisma schema and client
frontend/   React + TypeScript + Vite, Tailwind CSS
docs/       Product/architecture specs — read before implementing any feature
```
