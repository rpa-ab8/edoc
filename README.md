# Edoc

Edoc is a universal, multi-sector document management system. See `CLAUDE.md` and `docs/` for full product
and architecture context.

## Documentation

- **[Developer Guide](docs/developer/README.md)** — architecture, setup, database schema, security & permissions,
  every backend module and function, end-to-end workflows, frontend, testing, deployment, conventions and known gaps.
- **[API Reference](docs/API_Reference.md)** — every endpoint with guards, request/response shapes and error codes.
- Product specs (`docs/DMS_*.md`), the security audit (`SECURITY_AUDIT.md`) and the change log (`each_update.md`).

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

5. **Optional workers** (separate terminals):

   ```bash
   npm run worker:dev --workspace backend             # OCR, so scanned files become searchable
   npm run worker:retention:dev --workspace backend   # daily auto-delete + Trash purge (02:00 IST)
   npm run retention:run-once --workspace backend     # run the retention job once, now, and exit
   ```

   Nothing is ever auto-deleted unless a Department Admin sets an auto-delete period for their
   department (Department settings → Retention). Documents under a Legal Hold are never deleted.

## Checks

The audit trail is append-only in the database (SECURITY_AUDIT.md M-1), so the suites can only remove
their own audit-event fixtures on a database marked disposable. Run this once on a **dev** database
(it refuses `NODE_ENV=production` and non-local hosts; never do it on production):
`npm run db:mark-disposable --workspace backend`.

Each suite is a script against the dev database (`npm run check:<name> --workspace backend`):
`permissions`, `folders`, `documents`, `upload`, `search`, `viewer`, `sharing`, `confidential`,
`trash`, `audit`, `tenant-isolation`, `access-matrix`, `performance`, and for PRD v1.2 `retention`,
`legal-hold`, `filters` and `rename` (the last needs no database).

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
