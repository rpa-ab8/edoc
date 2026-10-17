Place `schema.prisma` in this directory (`backend/prisma/schema.prisma`).

It should be the source of truth already reviewed against `docs/DMS_Data_Model.md` — do not
regenerate it from scratch here. Once it's in place:

```bash
npm run docker:up                        # start Postgres + Redis (from repo root)
npm run prisma:generate --workspace backend
npm run prisma:migrate --workspace backend
npm run prisma:studio --workspace backend
```
