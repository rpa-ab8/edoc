# Edoc — Developer Guide

Edoc (renamed in PRD v1.2; internal identifiers — the repo folder, database and compose names — still say `dms`) is a multi-tenant document
management system: organizations → departments → folders → documents with versions, metadata, OCR'd full-text
search, sharing, confidential vaults, trash, retention and Legal Hold, and an append-only audit trail.

This guide is for the next developer. It explains **how the system is built and why**, from first checkout to
production, and points at the exact files. It was written from the code on 2026-11-07.

## Reading order

| # | Chapter | Read it when you… |
|---|---|---|
| 01 | [Architecture](01_Architecture.md) | start — the big picture, processes, request lifecycle, repo map |
| 02 | [Getting started](02_Getting_Started.md) | set up a machine, need an env var, a script, or the first login |
| 03 | [Database schema](03_Database_Schema.md) | touch any table, query or migration |
| 04 | [Security & permissions](04_Security_and_Permissions.md) | touch auth, roles, permissions, confidential folders, sharing access |
| 05 | [Backend modules](05_Backend_Modules.md) | work in `backend/src` — every module, function and rule |
| 06 | [End-to-end workflows](06_Workflows.md) | need to see how a feature flows across modules, UI and workers |
| 07 | [Frontend](07_Frontend.md) | work in `frontend/src` |
| 08 | [Testing](08_Testing.md) | write or run the `check:*` suites |
| 09 | [Deployment & operations](09_Deployment_and_Operations.md) | deploy, back up, restore, monitor, debug production |
| 10 | [Conventions, extending & known gaps](10_Conventions_and_Extending.md) | add an endpoint/permission/module, or want the list of traps |
| 11 | [Backup and restore (production runbook)](11_Backup_and_Restore.md) | need to restore data, run the monthly drill, or check the backups |

Also: **[API Reference](../API_Reference.md)** — every endpoint, request, response and error code.

## The other documents in `docs/` (product side)

| File | What it is | Authority |
|---|---|---|
| `DMS_Scope_and_MVP_Definition.md` | What is in Release 1 vs later | **Wins if docs conflict** |
| `DMS_Product_Requirements_Document (1).md` | Requirement IDs (`SHR-4`, `RET-3`…) and acceptance criteria | Cite IDs in commits |
| `DMS_Feature_and_Flow_Specification.md` | Behaviour and screens of every feature | Behaviour |
| `DMS_Data_Model.md` | Entities and fields (the Prisma schema follows it) | Naming |
| `DMS_Technology_Stack.md` | Library / hosting choices and why | Stack |
| `DMS_Deployment_Guide.md` | Step-by-step production server setup | Ops runbook |
| `../SECURITY_AUDIT.md` | Security findings and their fix status | Security |
| `../each_update.md` | Chronological log of every change | History |
| `../DEVELOPMENT_ROADMAP.md` | Module-by-module build plan | Planning |
| `../CLAUDE.md` | The hard rules (also summarised in chapter 01) | **Never violate** |

## The ten hard rules (memorise these)

1. **Tenant isolation** — every table except `user` carries `organization_id`; every query filters on it.
2. **One role per user per department** — unique `(user_id, department_id)` on `membership`.
3. **Document ID is immutable**, never reused, shared by all versions.
4. **Versions are never overwritten** — a new version is a new row; restoring copies forward.
5. **Sharing is by reference**, never by copy.
6. **Folder overrides only restrict**, never grant beyond the role.
7. **Confidential folders** — named users only, invisible to everyone else (search, listings, counts by name),
   Super Admin excluded, enforced at the query layer.
8. **Audit records are append-only** — no update/delete path; a DB trigger enforces it.
9. **`document.uploadedAt` is immutable** — it is the auto-delete clock; a DB trigger enforces it.
10. **A Legal Hold blocks every destruction path**, and **storage is only reached through the storage
    abstraction**.
