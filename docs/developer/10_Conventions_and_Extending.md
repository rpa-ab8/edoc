# 10 — Conventions, extending, and known gaps

## 1. Coding conventions

- **TypeScript ESM** everywhere. Backend imports use the `.js` extension (`import … from "./x.js"`) even for
  `.ts` files (NodeNext resolution).
- **Names follow `docs/DMS_Data_Model.md`** exactly (tables, columns, enums, types).
- **Module shape**: `routes` (HTTP only) → `service` (logic, framework-free) → `lib`. Services take `deps` and
  `actor` first; never read `request` in a service.
- **Every query carries `organizationId`**; ids from the request are never trusted alone.
- **Refusals throw `<Module>Error(status, code, message)`**; codes are snake_case and stable — clients branch on
  them. Messages are user-facing sentences.
- **404 for invisible, 403 for visible-but-forbidden.**
- **Audit after the state change** with `logAuditEvent`; the description names the document ref.
- **Comments explain decisions**, citing requirement IDs (`RET-3`, `SHR-4`) and audit IDs (`SECURITY_AUDIT.md H-2`).
  Many "FLAGGED" comments mark places where the docs were silent and a decision was made — keep them accurate.
- **Formatting / lint**: Prettier + ESLint (`npm run lint` in both workspaces). Typecheck must be clean.
- **Change log**: every change gets an entry in `each_update.md`.
- **Never put credentials in tracked files** — test logins live in `CLAUDE.local.md` (git-ignored).
- **Commits**: only when asked; cite requirement IDs.

## 2. Release scope

Only **Release 1** (as amended by PRD v1.2) is built. Do **not** build Release 2 items (workflow/approvals,
retention locks, per-type retention, auto-archive, expiry reminders, notifications, auto-extraction, reporting)
unless explicitly asked — but don't break their reserved fields (`document.workflowState`, the `workflow.*`,
`reports.*`, `search.saved_searches` keys). `docs/DMS_Scope_and_MVP_Definition.md` decides what's in scope.

## 3. Recipes

### Add an endpoint
1. Zod schema (in the routes file or `*.schemas.ts`).
2. Route in `<module>.routes.ts` with the right guard chain: `std` (`authenticate, requireVerifiedEmail,
   requireOrganization`) plus `requirePermission(key[, extractor])` when the department/folder is in the route —
   otherwise check inside the service.
3. Service function: tenant-scoped queries, engine calls (`resolveEffectivePermissions` / `hasPermission`),
   domain errors, audit event.
4. Typed client in `frontend/src/lib/<area>.ts` with the response interface.
5. A check script (HTTP-level if guards matter) with positive controls; add it to `package.json`.
6. Document it in `docs/API_Reference.md` (index + section + error codes) and chapter 05.

### Add a module
Create `modules/<name>/{name.routes.ts,name.service.ts}`, a `<Name>Error` class, register the routes in
`app.ts` with a prefix, and **add the error class to the global error handler** in `app.ts`.

### Add a permission key
1. Add it to `PERMISSION_CATALOGUE` (`lib/permissions.ts`) — `group.key`, a label, `inactiveInR1` if needed.
2. Dependencies in `PERMISSION_DEPENDENCIES` if it needs a parent.
3. Decide which template roles get it (`department.templates.ts`; Department Admin gets every R1-active key
   automatically). Decide whether the Super Admin baseline gets it (`SUPER_ADMIN_ADMINISTRATIVE_KEYS`).
4. **Existing roles don't change by themselves** — write a migration that grants it to the right existing roles
   (pattern: the retention migration's `UPDATE "role" SET "permissions" = "permissions" || '{"key": true}'`
   for Department-Admin-capable roles).
5. Enforce it (route guard or service) and add tests. The role editor picks it up from the catalogue endpoint.
6. Never rename or delete an existing key.

### Add an audit action
`ALTER TYPE "AuditAction" ADD VALUE '<action>'` in a migration, add it to the Prisma enum, to `AUDIT_ACTIONS`
in `audit.routes.ts`, to the frontend `AuditAction` type and the AuditPage labels.

### Add an environment variable
`config/env.ts` (zod, with a default where sensible) → `.env.example` + `.env.production.example` → chapter 02 →
deploy docs if operators must set it.

### Add a migration
See chapter 03 §5. Raw SQL for constraints/triggers via `--create-only`; `down.sql` for risky ones.

### Add a frontend page
Page in `pages/`, route in `App.tsx` wrapped in `ProtectedRoute` with the right flags, data via TanStack Query
and `lib/*` clients, controls driven by `my-permissions` / `document.permissions`, styled with the existing
tokens and components.

## 4. Traps and non-obvious behaviour

| Trap | Detail |
|---|---|
| **Catalogued but unenforced keys** | `sharing.remove_share`, `search.advanced_search`, `configuration.edit_metadata_schema` are in the matrix and in template roles, but **no server code checks them**. Revoking a share is the sharer's self-service; advanced filters need only `search.search`; field definitions are edited under `configuration.edit_document_type`. Don't assume unticking them removes anything. |
| **JWT claims are hints** | `organizationId`/`isSuperAdmin` in the token are re-verified per request; don't add code that trusts a claim without the DB. |
| **The Super Admin can't read documents** without a membership | By design (chapter 01 §7). Tests that use a Super Admin to open documents will get 404. |
| **Confidential named members get a floor** even with no role | view/preview/download/history/search. |
| **`document_type` / `field_def` have no `organizationId`** | Always scope them through a verified `departmentId`. |
| **Prisma column names are camelCase** | Raw SQL must quote them: `d."organizationId"`, `"uploadedAt"`. Tables are snake_case. |
| **`searchVector` isn't in the Prisma client** | Write it only via `refreshDocumentSearchVector`; call it after any change to ref/title/fields/current version/OCR. |
| **`uploadedAt` and `audit_event` are trigger-protected** | Updates fail at the DB. Test cleanup must use `purgeTestAuditEvents`. |
| **Search quick views `shared_with_me` / `trash` return `[]`** | Those views use `/shares/with-me` and `/departments/:id/trash`. |
| **Expired shares are deleted lazily** | `purgeExpiredShares` runs on share-list loads. |
| **Upload bodies are buffered in memory** | Bounded by the upload limiter; true streaming is open work (M-5). |
| **OCR needs the worker** | Without it, versions stay `pending` and OCR text isn't searchable. |
| **Check scripts hard-code `C:/apps/DMS/.env`** | `dotenv.config({ path: "C:/apps/DMS/.env" })` — on another machine/OS the file simply isn't found and the env must come from the shell (CI sets it). The npm scripts also load `../.env`. |
| **Several suites need the "Abate" org and its R2** | `check:upload`, `check:performance` and others; they won't run on an empty DB. |
| **`npm audit fix --omit=dev`** | Removes dev dependencies from `node_modules`; run `npm install` to recover. |
| **Windows dev** | Git Bash and PowerShell both work; prefer forward slashes in scripts; Docker Desktop must be running for Postgres/Redis. |
| **`clearFolderPermission` writes no audit event** | Setting an override does (`permission_change`). |
| **`storage_config.usedBytes` only grows** | Not decremented on purge; `quotaBytes` not enforced. |
| **`login_attempt` grows forever** | No pruning job yet. |

## 5. Known gaps and open work (consolidated)

| Area | Item | Reference |
|---|---|---|
| Security | Least-privilege DB role for the app | SECURITY_AUDIT M-1 |
| Security | Antivirus, streaming uploads, OCR worker sandbox | M-5 |
| Security | Prisma 7 upgrade (deepmerge-ts), CI audit gate | M-8 |
| Security | Low findings L-1…L-10 (CSV formula injection, link-open attribution, login enumeration, refresh reuse detection, invite-code race, JWT pinning, rate limits on expensive authenticated routes, …) | SECURITY_AUDIT §4 |
| Product | Link passwords for external links (decision pending) | H-4 notes |
| Product | Owner notification when a vault list changes (Release 2 notifications) | M-6 notes |
| Product | Department-level share oversight (would give `sharing.remove_share` meaning) | Feature Spec §7.4 |
| Data | `usedBytes` on purge, quota enforcement, `login_attempt` pruning | this chapter |
| Docs | `docs/DMS_Feature_and_Flow_Specification.md` §2A.1 still says the Super Admin can act in any department; code deliberately differs (chapter 01 §7) | effective-permissions.ts comment |
| Tests | `check:legal-hold` timing flake (Docker vs host clock) | chapter 08 |
