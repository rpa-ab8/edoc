# DMS Project — Instructions for Claude Code

## What this is
**Edoc** — the user-facing product name since PRD v1.2 (formerly "DMS"; internal identifiers such as the repo folder, `docs/DMS_*.md` file names and the `dms` database/compose names are unchanged). Universal, multi-sector document management system. Multi-organization architecture, single organization in production for now. Full design is in `docs/` — read the relevant doc before implementing a feature, don't guess from this file alone.

## Read before working on...
- **Any feature's behaviour or screens** → `docs/DMS_Feature_and_Flow_Specification.md`
- **Whether something is in Release 1 or deferred** → `docs/DMS_Scope_and_MVP_Definition.md` (this is the authority if docs conflict)
- **Schema, entities, relationships, table fields** → `docs/DMS_Data_Model.md`
- **Requirement IDs / acceptance criteria for a feature** → `docs/DMS_Product_Requirements_Document.md`
- **Library/hosting/infra choices** → `docs/DMS_Technology_Stack.md`

## Stack (see Technology Stack doc for full reasoning)
- Frontend: React + TypeScript + Vite, Tailwind, TanStack Query, Zustand
- Backend: Node.js + TypeScript, Fastify, Zod, Prisma
- Database: PostgreSQL (JSONB for permission matrices, tsvector for search)
- Queue/cache: Redis + BullMQ
- OCR: Tesseract (self-hosted)
- Auth: JWT access tokens + server-side refresh tokens (self-built, no third-party provider)
- Storage: pluggable — NAS or Cloudflare R2 behind a storage abstraction interface

## Hard rules — do not violate
- **Tenant isolation**: every table except `user` carries `organization_id`. Every query filters on it. No exceptions, no "just this once."
- **One role per user per department.** Unique constraint on (user_id, department_id) in `membership`.
- **Document ID is immutable** once assigned, never reused, shared across all versions of a document.
- **Versions are never overwritten.** A new version is a new row; restoring an old version copies it forward as a new current version.
- **Sharing is by reference, never by copy.** A share row points at the original document.
- **Folder permission overrides can only restrict, never grant** beyond what the role allows.
- **Confidential folders**: named-user access only (no role inheritance), excluded from all search/listings/counts for non-members, Super Admin excluded, enforced at the query layer not just the UI.
- **Audit records are append-only.** No update or delete path, for anyone, ever.
- **A document's Upload Date (`document.uploadedAt`) is immutable** — it is the auto-delete clock (RET-2). A DB trigger refuses changes; never write it after insert.
- **A Legal Hold blocks every destruction path** — user delete, auto-delete, single purge, "Empty trash", the automatic trash purge. All of them go through `moveDocumentToTrash` / `destroyTrashedDocument` in `document.service.ts`; never add a deletion path that bypasses them.
- **Storage access only through the abstraction layer.** Never call a storage SDK (S3/R2 client, filesystem path) directly from feature code — always through the interface, so backends stay swappable.

## Current build phase
Release 1 only, as amended by PRD v1.2 (which brought the per-department auto-delete period, the daily retention run, Legal Hold and the standard Upload Date filter into R1 — see PRD §8.14). Do not build Release 2 items (workflow/approvals, retention locks / per-document-type retention / auto-archive / expiry reminders, notifications, auto-extraction, reporting) unless explicitly asked — but don't actively break the reserved columns/fields the data model sets aside for them (e.g. `document.workflow_state`).

## Working conventions
- Follow the data model's entity/field names exactly when naming tables, columns and types.
- Requirement IDs (e.g. `SHR-4`, `DOC-2`) from the PRD are the reference for acceptance criteria — cite them in PR descriptions/commits where relevant.
- When a design ambiguity comes up that the docs don't resolve, flag it rather than assuming — this project has a lot of deliberately-decided edge cases (see "Hard rules" above); guessing wrong here is expensive.

## Always update each_update.md file after a edit to keep the note of what we did 
## Use world class top ui try to feel the screen and keep it premium and proffecinal while working on ui be more strict in ui desinging 
## read each_update.md and DEVELOPMENT_ROADMAP.md while staring a section 
## Test account logins live in `CLAUDE.local.md` (gitignored) — never put credentials in this file