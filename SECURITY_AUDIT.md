# Edoc — Security Audit (Step 1: access control & tenant isolation)

**Date:** 2026-11-07
**Scope:** `backend/` (Fastify API, Prisma schema, workers), `frontend/src` (XSS/token handling), `deploy/` and `docker-compose*.yml`, dependency audit.
**Method:** Manual source review of every route and service in `backend/src/modules/*`, the permission engine (`lib/permissions.ts`, `lib/effective-permissions.ts`, `plugins/authenticate.ts`), auth, sharing, storage and retention. `npm audit` for dependencies.
**Not done:** no live exploitation. The API, Postgres and Redis were not running in this environment (Docker was down), so every finding below is **confirmed by reading the code**, not by sending requests. Each High finding includes a reproduction recipe so it can be verified (and turned into a regression test) in minutes. No code was changed.

Severity scale: **High** = break of a CLAUDE.md hard rule or a realistic path to data you should not reach · **Medium** = real weakness needing a precondition · **Low** = hardening / defence-in-depth.

---

## 1. Summary

| # | Severity | Finding | Area |
|---|---|---|---|
| H-1 | **High** — ✅ **Fixed 2026-11-07** | Department/folder mismatch: the permission check uses the department in the URL, but services act on the folder ID alone — cross-department access inside one organization. Confirmed live (17 failing checks), fixed in the permission engine + folder/document/upload services, verified by `npm run check:department-binding` (29/29) and the full suite | Tenant/department isolation |
| H-2 | **High** — ✅ **Fixed 2026-11-07** | A view-only share leaks the folder ID and document-type ID, which are exactly what H-1 needs; also, version history, uploader e-mails and the activity feed were returned to anyone with `documents.view` (UI-only hiding). Confirmed live (17 failing checks), fixed in `document.service.ts`, verified by `npm run check:share-exposure` (42/42) and the full suite | Sharing + H-1 |
| H-3 | **High** — ✅ **Fixed 2026-11-07** | Roles can be edited to grant more than the editor holds — self-escalation to Department Admin with `members.change_role` alone. Confirmed live (16 failing checks), fixed in `department.service.ts` role create/copy/update/delete, verified by `npm run check:role-escalation` (24/24) and the full suite | Permission model |
| H-4 | **High** — ✅ **Fixed 2026-11-07** | External links are not re-checked when the document later becomes confidential, is trashed, or the sharer loses access. Confirmed live (30 failing checks), fixed in `sharing.service.ts` `resolveLink`, verified by `npm run check:link-revalidation` (48/48) and the full suite | Sharing / confidential |
| M-1 | Medium — 🟡 **Partly fixed 2026-11-07** | Audit "append-only" is enforced by code convention only — no database protection. DB trigger now refuses UPDATE/DELETE/TRUNCATE (verified by `npm run check:audit-immutability`, 18/18); the least-privilege DB role is still open | Audit |
| M-2 | Medium — ✅ **Fixed 2026-11-07** | Disabled / removed users keep working access for up to 15 min (stale JWT claims); refresh does not re-check user status. Confirmed live (9 failing checks), fixed in `plugins/authenticate.ts` + `auth.service.ts refresh`, verified by `npm run check:session-revocation` (17/17) and the full suite | Auth |
| M-3 | Medium — ✅ **Fixed 2026-11-07** | Login lockout is per-email only → anyone can lock out any known account. Confirmed live, fixed in `auth.service.ts login` (per email+IP lock, per-account ceiling with trusted IPs), verified by `npm run check:login-lockout` (9/9) | Auth |
| M-4 | Medium — ✅ **Fixed 2026-11-07** (`check:storage-targets` 25/25) | NAS `mountPath` and R2 `endpoint` are free-form, set by a tenant's Super Admin: arbitrary server directory writes and SSRF | Storage |
| M-5 | Medium — 🟡 **Partly fixed 2026-11-07** (content check + concurrency cap; `check:upload-content` 29/29; scanner/streaming/worker sandbox open) | Upload type check trusts the declared MIME / extension; no content sniffing, no malware scan; whole file buffered in memory | Uploads / availability |
| M-6 | Medium — ✅ **Fixed 2026-11-07** (owner-only, product decision; `check:vault-owner` 13/13) | Confidential-folder member management is open to every named member, not only the Owner | Confidential folders |
| M-7 | Medium — ✅ **Fixed 2026-11-07** | A member can modify or remove people more privileged than themselves (`members.change_role` / `members.remove`). Confirmed live, fixed in `department.service.ts` `changeMemberRole`/`removeMember`, verified by `npm run check:member-hierarchy` (16/16) and the full suite | Permission model |
| M-8 | Medium — 🟡 **2 of 3 fixed 2026-11-07** (zod 4.6.7, fast-uri patched; deepmerge-ts accepted until Prisma 7 — CLI-only, unreachable) | Vulnerable dependencies in the backend (`zod` high, `deepmerge-ts` high, `fast-uri` moderate) | Supply chain |
| L-1 | Low | CSV export has no formula-injection neutralisation | Audit export |
| L-2 | Low | External-link opens are logged as the *sharer*; file downloads via link are not logged separately | Audit integrity |
| L-3 | Low | `search.search` is not tied to `documents.view`; search can list a role that cannot view | Permission model |
| L-4 | Low | Login timing / state differences allow account enumeration (disabled-account response, no hash work for unknown emails) | Auth |
| L-5 | Low | No refresh-token reuse detection; refresh rotation is not atomic | Auth |
| L-6 | Low | Invite-code use is a non-atomic read-then-increment | Signup |
| L-7 | Low | Dev `docker-compose.yml` publishes Postgres/Redis with default password | Deployment |
| L-8 | Low | Test scripts delete audit events against whatever `DATABASE_URL` is set | Operations |
| L-9 | Low | JWT verification does not pin the algorithm or issuer/audience | Auth |
| L-10 | Low | No rate limit on authenticated, expensive endpoints (search, upload, audit export) | Availability |

**Overall:** the design is careful — a single permission engine, organisation filters on essentially every query, hashed tokens, httpOnly refresh cookie, argon2id, parameterised SQL, 404-instead-of-403 for hidden things. The serious problems are **gaps between layers** (H-1, H-2, H-4) and one **privilege-escalation path** (H-3), not missing basics.

---

## 2. High severity

### H-1 — Department ID and folder ID are never tied together

**CLAUDE.md rules at risk:** tenant isolation (department level), "folder permission overrides can only restrict", confidential-folder rules (partly).

**Where**
- `backend/src/plugins/authenticate.ts:118-125` — `defaultTarget` takes `departmentId` from the URL (or body/query) and `folderId` from the URL, independently.
- `backend/src/lib/effective-permissions.ts:114-135, 143-151` — `loadFolderChain` filters folders by `organizationId` **only**; `resolveEffectivePermissions` then looks up the user's membership for the *supplied* `departmentId`. It never checks `folder.departmentId === departmentId`.
- Services then act on `folderId` alone:
  - `document.service.ts:715-745` `listFolderDocuments` (department of the folder is only used for the hold index)
  - `document.service.ts:300-307` `createDocument` (used by upload)
  - `folder.service.ts:283-288` `loadFolder` → `renameFolder`, `moveFolder`, `deleteFolder`, `folderPath`, `setFolderPermission`, `clearFolderPermission`
- Contrast — **correct** handling exists in `retention.service.ts:393-405` (`placeFolderHold` looks the folder up with `departmentId` in the `where`) and `folder.service.ts:194` (`createFolder` parent lookup). The rest of the folder/upload/document-list paths lack it.

**Affected routes (all same organisation, different department)**
- `GET /documents?departmentId=A&folderId=B` — lists the active documents (ID, title, filename, size, type) of folder B
- `POST /departments/A/folders/B/documents/upload` — files a document into B (needs B's document-type ID)
- `PATCH /departments/A/folders/B` (rename), `POST …/B/move`, `DELETE …/B`
- `GET /departments/A/folders/B/path`, `GET/PUT/DELETE …/B/permissions…`
- `GET /departments/A/my-permissions?folderId=B` (information only)

**Why it works:** the caller needs only the relevant permission *in department A* (their own). The resolver evaluates their role in A against folder B's override chain; B is never required to belong to A. A confidential folder B is still protected (its confidentiality flag is read from the chain and the named-list check applies), so this affects ordinary, non-confidential folders.

**Precondition:** an attacker must know a folder UUID of another department. UUIDs are not guessable — but see **H-2**, which supplies them to any share recipient.

**Reproduce (to confirm, then convert to a regression test):**
1. Org with departments A and B. User U is a member of A only, role with `documents.view` in A. Folder `fB` exists in B with a document.
2. As U, `GET /documents?departmentId=<A>&folderId=<fB>`.
3. Expected (correct): 404/403. Actual (from code): 200 with B's document list.

**Fix**
1. In `loadFolderChain`/`resolveEffectivePermissions`, require every folder in the chain to have `departmentId === departmentId`; if the first folder does not, return no permissions (and make routes answer 404, as elsewhere).
2. Add a shared helper `loadFolderInDepartment(prisma, actor, departmentId, folderId)` and use it in every folder-scoped service (`loadFolder`, `listFolderDocuments`, `createDocument`, `folderPath`, `myPermissions`).
3. Add regression tests to `scripts/check-access-matrix.ts` / `check-tenant-isolation.ts` for "right org, wrong department" on each route above. Existing tests cover cross-*organisation* (and the `document_type_mismatch` case) but not this.

---

### H-2 — A view-only share exposes the identifiers that unlock H-1

**Where:** `document.service.ts:255-290` `shapeDocument` returns `folderId`, `departmentId`, and the whole `documentType` row (including its `id`). `getDocument` is reachable by a share recipient through the share fallback (`document.service.ts:188-216`) — a view-only share is documented to give "the document ID, its metadata and an inline preview — nothing else."

**Impact:** a colleague who was shared **one** document learns the **folder** and **document-type** IDs of the home department, then uses H-1 to list every document in that folder, upload into it, rename/move/delete it (if they hold those permissions in their own department). "Sharing is by reference, a share points at the original document" is violated: the share becomes access to the folder.

**Fix:** fix H-1 first (that closes the exploit). In addition, return a reduced shape to share recipients (omit `folderId`, `departmentId`, `documentType.id`, field-definition IDs) — least privilege on the response.

**Found while fixing — same root cause (the API trusted the UI to hide things):** `getDocument` returned every version (with the uploader's e-mail and change notes) and the activity feed (who viewed / downloaded) to anyone holding `documents.view` — including a view-only share recipient — although the viewer only renders them with `documents.version_history`. `GET /documents/:id/activity` needed only `documents.view`, and `GET /documents/:id/file?versionId=` served any older version's bytes.

**Status — ✅ fixed 2026-11-07.**
- `shapeDocument` now takes a view derived from the permission map that admitted the caller. A share-only caller gets `departmentId`, `folderId`, `documentType.id`, `fieldDefId` and `trashReason` as `null`. A caller without `documents.version_history` gets only the current version, with no uploader or change note, and an empty activity feed. The same shaping applies to the edit-metadata, new-version, restore-version and restore-from-trash responses.
- `GET /documents/:id/activity` requires `documents.version_history`.
- `GET /documents/:id/file` serves a non-current version only with `documents.version_history`; otherwise it returns `version_not_found` (404).
- Frontend types made nullable. The viewer falls back to `/` for "Back" when no folder is known, and Share stays disabled for share recipients.
- Regression test `npm run check:share-exposure` (42 checks, with positive controls) fails 17 checks on the old behaviour and passes on the new.

---

### H-3 — Role editing can grant more than the editor holds

**CLAUDE/Spec rule at risk:** the engine has `canGrantRole` ("nobody hands out a role with more access than they hold") for *assigning* roles, but role *editing* bypasses it.

**Where:** `department.service.ts:778-809` `createRole`, `811-850` `copyRole`, `852-902` `updateRole` — each requires only `members.change_role` and never calls `assertCanGrantRole` (which exists at `:953` and is used for `addMember`/`changeMemberRole`, and in `invitation.service.ts:112`).

**Attack:** a user whose role has `members.change_role` (a delegated "HR manager" who may change member roles) edits **their own role** (or creates a role) with every permission ticked — including `members.invite`, `configuration.edit_rules`, `audit.export_audit`, `sharing.external_share`, `retention.manage_legal_hold`, then is effectively a Department Admin. Also: an attacker can edit a *lower* role, assign it to a colleague, etc.

**Fix**
- In `createRole`, `copyRole`, `updateRole`: call `canGrantRole(prisma, actor, departmentId, permissions)`; the Super Admin remains exempt.
- In `updateRole`, additionally refuse to edit a role that has *more* permissions than the editor (you cannot change a role above you), and refuse editing your own role's permissions upward.
- Add a Department-Admin-only gate for the Department Admin system role.

**Status — ✅ fixed 2026-11-07.** All role edits are now bounded by `canGrantRole`; the Super Admin is still exempt. Failures return 403 `role_exceeds_yours`.
- `createRole`: the role's permissions, after dependency closure, must be within the actor's own.
- `copyRole`: the source role must be within the actor's own.
- `updateRole`: both the role as it is now and the role as it will be must be within the actor's own. So you can't change, rename or strip a role above you, can't raise any role beyond yourself, and can only lower your own role. A re-save that changes nothing is allowed, because the roles page PUTs every role on each save.
- `deleteRole`: the role must be within the actor's own.
- The "Department-Admin-only gate" follows from this: only someone holding every permission of the Department Admin role can change it.
- Confirmed live before the fix: an HR manager with `members.change_role` gave their own role every permission (16 failing checks). Regression test: `npm run check:role-escalation` (24 checks with positive controls).
- The member-side half of the same rule is **M-7**, fixed separately (see below).

---

### H-4 — External links outlive the conditions that made them legal

**CLAUDE.md rules at risk:** "Confidential folders: … excluded …", Feature Spec §11.2 "a confidential document can never leave by link", Legal Hold / trash semantics.

**Where:** `sharing.service.ts:608-632` `resolveLink` checks only: token hash matches, `status === "active"`, not expired. `openLink` / `fetchLinkFile` (`:634-684`) then serve `document.currentVersionId` with no further checks.

**Gaps**
1. **Confidentiality is not rechecked.** Links are blocked at *creation* inside a confidential folder (`effective-permissions.ts:254`), but a folder can *become* confidential later — moving a folder into a confidential branch (`folder.service.ts:411-431`) flips `isConfidential` for the whole subtree and does **not** touch existing shares. The link keeps working for anyone holding the URL.
2. **Trashed documents stay downloadable.** `document.status` is not checked; "deleted" documents remain reachable by link until purge (the purge deletes the share rows, `document.service.ts:1154`).
3. **The sharer losing access** (removed from the department, disabled) does not stop their links.
4. **No password/second factor** on a link; the URL is the only secret. 256-bit random token and hashed storage are good (`tokens.ts`), but links often travel by email/chat.

**Fix**
- In `resolveLink`: load the document's folder chain; refuse if any ancestor is confidential or the document `status !== "active"`.
- On `moveFolder` into a confidential branch (and when a folder is marked confidential), revoke all `external_link` shares (and user/department shares) for documents in the subtree, and audit it.
- On member removal/disable, revoke or suspend that user's external links (or require the sharer to still hold `sharing.external_share` at open time).
- Optional: link password; log `fetchLinkFile` downloads (see L-2).

**Status — ✅ fixed 2026-11-07 (gaps 1–3).** Fixed by re-checking at open time instead of revoking on events. Every link open and file fetch (`resolveLink`) re-checks the conditions the link was created under, against the current state:
- the document is `active`;
- the sharer's user account is `active`;
- the permission engine, run as the sharer for the document's current folder, still grants `documents.view`, `sharing.share`, `sharing.create_link` and `sharing.external_share`. The engine turns the link keys off in or under a confidential folder and grants nothing for a removed or disabled membership. So one check covers confidentiality and the sharer losing access, however the folder became confidential;
- the department still has external links enabled.

Notes:
- A failed check *suspends* the link with the same uniform `link_unavailable` 404. It is not counted or logged as an access. Reversing the condition brings it back, and an explicit revoke stays final.
- A download link whose sharer lost `documents.download` drops to view-only.
- The "Shared by me" list still shows a suspended link as active, because no row is changed.
- Confirmed live before the fix (30 failing checks across 7 scenarios). Regression test: `npm run check:link-revalidation` (48 checks).
- **Not done:** gap 4 (link password) is a product decision, and L-2 (logging link downloads separately) remains open.

---

## 3. Medium severity

### M-1 — Audit trail is append-only by convention, not by database
`lib/audit.ts` only exposes `create`, and no application code updates/deletes `audit_event` (verified by grep). But there is **no DB-level protection** — the only trigger in the migrations is `document_uploaded_at_immutable`. Anyone with the application's DB credentials, a SQL-injection, or one future code change can edit history. The test scripts (`backend/scripts/check-*.ts`) already call `auditEvent.deleteMany`.
**Fix:** add a migration with a trigger that raises on `UPDATE`/`DELETE` of `audit_event` (allowing only the `ON DELETE SET NULL` of `documentId`, e.g. by permitting updates where only `documentId` changes to NULL), and run the app with a DB role that has `INSERT, SELECT` only on that table. Restrict test-only deletion to a separate test DB (see L-8).

**Status — 🟡 trigger done 2026-11-07; DB role still open.**
- **Done:** migration `20261107120000_audit_append_only`. Postgres now refuses every UPDATE, DELETE and TRUNCATE of `audit_event`, from Prisma or raw SQL alike, with two exceptions:
  - the FK's own `ON DELETE SET NULL`: an update whose only change is `documentId` going to NULL;
  - test cleanup, which needs **both** the database marked disposable (`ALTER DATABASE … SET dms.audit_purge_allowed = 'on'`, read from `pg_db_role_setting` so a session `SET` can't fake it) **and** a per-transaction opt-in.
- Production is never marked, so there it has no delete path at all. `npm run db:mark-disposable` refuses `NODE_ENV=production` and non-local hosts.
- All 19 test scripts now clean up via `scripts/_audit-purge.ts`. CI marks its throwaway database and runs the new suite.
- Verified by `npm run check:audit-immutability` (18 checks). Every tampering probe runs in a rolled-back transaction, so the check can't destroy history even without the trigger. All 11 probes succeeded before the migration.
- **Still open:** someone holding the database *owner* credentials can drop the trigger. Closing that needs the app (and worker) to connect as a separate role with only `INSERT, SELECT` on `audit_event` and no DDL, while `migrate` keeps the owner role. That changes `docker-compose.prod.yml`, the `DATABASE_URL` secrets and the deploy guide, so it's a deployment change to schedule, not a code fix.

### M-2 — Disabled/removed users keep access for up to 15 minutes; refresh ignores user state
- Authorisation reads `organizationId` / `isSuperAdmin` / `emailVerified` from the JWT (`authenticate.ts`), valid 15 min (`env.ts`). Disabling a member (`organization.service.ts:setMemberEnabled`) flips membership status, which the permission engine re-checks (good), but direct user shares (`share-access.ts`) and the confidential named list (`effective-permissions.ts:236-262`, no membership check) still grant access during that window.
- `auth.service.ts:373-427` `refresh` never checks `user.status` and `login` is the only place `user.status === "disabled"` is enforced. Revoked-membership users simply get a token without an organisation, so impact is limited, but a globally-disabled account would keep refreshing for 30 days.
**Fix:** check `user.status` in `refresh`; on disable/remove, revoke refresh tokens (or add a per-user "token version" claim compared in `authenticate`); require an active membership in `resolveConfidential` and `resolveSharedAccess`; shorten the access token (5 min) or add a small Redis denylist keyed by `userId`.

**Status — ✅ fixed 2026-11-07.**
- **`authenticate`:** re-checks the token's claims on every request. The account must still be `active` (otherwise 401 `account_disabled`), and the user must still belong to the organization the token names, as its owner or an active member of any department (otherwise 401 `session_revoked`). Super Admin is now re-derived from `organization.createdByUserId` rather than taken from the claim. This one check covers direct shares, confidential named-list access and every org-scoped route.
- **`refresh`:** refuses a disabled account and revokes **all** of its refresh tokens.
- **Deliberately unchanged:** a confidential folder's named members who hold no role in that department still get floor access, which is the confidential design. They lose it with their organization access.
- **Cost:** two indexed lookups per request; `check:performance` search timings are unchanged at 7–28 ms.
- Confirmed live before the fix (9 failing checks, including a disabled account still refreshing and a stale Super Admin claim being honoured). Regression test: `npm run check:session-revocation` (17 checks).

### M-3 — Account lockout can be weaponised
`auth.service.ts:260-300`: failures are counted by email only (`login:fail:<email>`, 5 attempts → 15-minute lock). An attacker needs 5 requests per 15 minutes to keep any known email permanently locked. The IP rate limit (30/min) does not help here.
**Fix:** count failures per (email, IP) with a global ceiling per email that triggers a CAPTCHA/step-up instead of a hard lock, or lock with exponential back-off keyed on both; keep the generic error message.
**Status — ✅ fixed 2026-11-07 (no CAPTCHA; trusted-IP step-up instead).**
- `LOGIN_MAX_ATTEMPTS` (5) failures lock the **(email, IP) pair** for `LOGIN_LOCKOUT_MINUTES`, so an attacker locks only their own IP.
- A per-account counter across all IPs catches distributed guessing. Past `LOGIN_MAX_ATTEMPTS_PER_ACCOUNT` (50) in the window, only IPs with a successful login for that account in the last `LOGIN_TRUSTED_IP_DAYS` (30) may keep trying, so the owner still gets in from their usual place.
- The owner's success clears only their own IP's counter, never the per-account one. Unknown emails are counted identically, and the generic 429 message is kept.
- Confirmed live before the fix: one attacker IP locked the owner out from every IP (4 failing checks). Regression test: `npm run check:login-lockout` (9 checks).
- **Residual:** an attacker on the owner's own network (a shared office IP) can still lock that pair. A CAPTCHA or e-mailed unlock link would close it and is a product decision.

### M-4 — Storage configuration is a server-side file-system and SSRF primitive
- `storage.schemas.ts:3-9`: NAS `mountPath` is any non-empty string. `nas.driver.ts:27-72` writes/reads/deletes under `path.join(mountPath, key)`. A Super Admin of *any* tenant can point it at any directory the API process can write — including another tenant's NAS mount, or application directories — and the connection test then writes and deletes files there. Keys themselves are server-generated (`${organizationId}/${uuid}`), so there is no traversal today, but there is no guard (`path.relative` check) if a key ever includes user input.
- `storage.schemas.ts:12-19`: R2 `endpoint` is any URL. The server then sends signed `HeadBucket/Put/Get/Delete` requests to it and returns mapped error text, enabling blind SSRF to internal services or the cloud metadata address.
**Fix:** restrict `mountPath` to an allow-listed base directory configured in env (e.g. `STORAGE_NAS_ROOT`) and resolve+verify containment; validate R2 endpoints (HTTPS only, hostname must match `*.r2.cloudflarestorage.com` or an allow-list, resolve and block private/link-local ranges). Add a `path.resolve`-containment assertion inside the NAS driver for defence in depth.
**Status — ✅ fixed 2026-11-07.** New `storage.policy.ts`, applied inside `buildDriver`, the only way a driver is built, so the rule holds on save, on re-test and on every live use, including configs saved before the rule or written straight to the DB.
- **NAS:** the mount path must be absolute and resolve (symlinks and junctions followed) inside `STORAGE_NAS_ROOT`. A missing path and an outside path get the same answer, so there's no existence oracle. In production, NAS is refused until `STORAGE_NAS_ROOT` is set; in development an unset root accepts any path.
- **R2:** the endpoint must be `https://<32-hex-account>.r2.cloudflarestorage.com` (a jurisdiction subdomain is allowed) with no credentials, port, path or query in the URL, or a host listed in `STORAGE_R2_ALLOWED_HOSTS`. Refused endpoints are never contacted.
- **NAS driver:** a key that resolves outside the mount throws.
- **DNS check:** no DNS resolve-and-block step was added. The suffix rule pins Cloudflare's own domain, and an allow-listed host is the administrator's explicit choice.
- Both existing dev configs (R2 on `*.r2.cloudflarestorage.com`) still pass.
- Confirmed live before the fix (21 failing checks): an outside folder was saved as "verified", localhost, the metadata address and example.com were really contacted (example.com's answer came back as an error message), and a `../` key wrote outside the mount.
- Regression test: `npm run check:storage-targets` (25 checks).

### M-5 — Upload validation and resource exhaustion
- `upload-formats.ts` `resolveFormat` accepts a file if the declared MIME **or** the extension matches; content is never inspected. A renamed file is stored and later served with the trusted canonical MIME (`document.routes.ts:126`, `Content-Disposition: inline` for previews). SVG/HTML are correctly rejected by type, and Caddy sets `nosniff`, which limits impact.
- No antivirus step. DOCX/XLSX are zip files and are stored as-is (no zip-bomb concern while there is no extraction; Tesseract/pdf-parse do process hostile images/PDFs, mitigated only by `OCR_MAX_PAGES`).
- `upload.routes.ts:50` `part.toBuffer()` loads the whole file (up to 120 MB) in memory per request, with no per-user/concurrency limit — ~50 concurrent uploads can exhaust an 8 GB host.
**Fix:** verify magic bytes (PDF `%PDF`, PNG/JPEG signatures, OOXML zip + `[Content_Types].xml`); stream to storage instead of buffering; add per-user upload rate/concurrency limits; add ClamAV (or a managed scanner) before marking a file available; run the OCR worker with CPU/memory/time limits and a dedicated unprivileged container.
**Status — 🟡 partly fixed 2026-11-07 (content check + concurrency cap done; scanner, streaming and worker sandbox open).**
- ✅ **Content decides the format** (`upload-formats.ts` `verifyUploadFormat`, used by both upload paths):
  - The bytes must be a real PDF (`%PDF-` in the first 1 KB), PNG, JPEG, or an OOXML ZIP whose directory holds `[Content_Types].xml` plus `word/document.xml` (DOCX) or `xl/workbook.xml` (XLSX). The ZIP check reads only the directory and decompresses nothing.
  - The content must also agree with the name and declared type. JPEG ↔ PNG is the one tolerated mismatch.
  - The stored MIME is the **detected** one. Refusals happen before anything is stored, with codes `unrecognised_content` / `content_mismatch` and messages users can act on.
- ✅ **Concurrency cap** (`lib/upload-limiter.ts`):
  - A slot is taken per upload *before* the body is read: `MAX_CONCURRENT_UPLOADS` (8) per process and `MAX_CONCURRENT_UPLOADS_PER_USER` (2). Worst-case memory is now about 1 GB.
  - Over the limit returns 429 `upload_busy` with Retry-After. The web client uploads one file at a time, so normal use never hits it.
- Confirmed live before the fix: an HTML page, an executable and an SVG were stored as PDF/PNG (21 failing checks). Regression test: `npm run check:upload-content` (29 checks). Test fixtures now use real minimal files (`scripts/_fixture-files.ts`).
- ⏳ **Open (infrastructure / larger refactor, not done):**
  - an antivirus scan (ClamAV sidecar or a managed scanner) before a file is marked available;
  - true streaming to storage, which needs the storage interface to take a stream and duplicate detection to hash while streaming;
  - running the OCR worker in its own unprivileged container with CPU, memory and time limits.

### M-6 — Any named vault member can add and remove other members
`confidential.service.ts:110-150`: `addMember`/`removeMember` require only `requireVaultMember` (being on the list) — not Owner. A non-owner member can add any organisation user (widening the vault) or remove every other non-owner (denial of access). The Owner is protected, but the model says the Owner controls the list.
**Fix:** require `isOwner` (or an explicit "manage members" flag) for add/remove, and log both with the actor — already logged — plus notify the Owner.
**Status — ✅ fixed 2026-11-07.**
- **Decision:** the docs didn't say who manages the list, so I asked the product owner, who chose **owner-only**. It's recorded in Feature Spec §11.1 and Data Model §6.
- **Backend:** `addMember` / `removeMember` now require the vault owner. A member who isn't the owner gets 403 `not_vault_owner`; a non-member still gets 404, so the vault stays invisible. `listMembers` returns `canManage`.
- **UI:** the dialog shows Add and Remove only to the owner.
- **Audit:** the removal event now names who was removed (it said "a member" before).
- **Not done:** notifying the owner. Notifications are Release 2.
- Confirmed live before the fix: a member added an outsider and removed a colleague. Regression test: `npm run check:vault-owner` (13 checks); `check:confidential` still 29/29.

### M-7 — No "can't modify someone above you" rule
`department.service.ts:1009-1077`: `changeMemberRole` / `removeMember` guard only against removing the *last* admin. A role holding `members.change_role` / `members.remove` can demote or remove Department Admins (as long as another admin remains) — e.g. an HR manager removing the department's admins one at a time.
**Fix:** reuse the H-3 comparison: the target's current role permissions must be a subset of the actor's; otherwise refuse.
**Status — ✅ fixed 2026-11-07.** Both `changeMemberRole` and `removeMember` now call `assertMemberWithinReach`, built on `canGrantRole`. If the target's current role holds any permission the actor lacks, the call is refused with 403 `member_above_you`. Peers with the same role and the actor themselves stay reachable, and the Super Admin is exempt. The org-level enable/disable path is Super-Admin-only and unaffected.
- Confirmed live before the fix: an HR manager demoted one admin and removed another (7 failing checks).
- Regression test: `npm run check:member-hierarchy` (16 checks with DB verification and positive controls, including the last-admin guard).

### M-8 — Dependency vulnerabilities (backend `npm audit --omit=dev`)
`zod < 4.6.6` (high — memory exhaustion validating very large constrained collections), `deepmerge-ts < 8.0.0` (high), `fast-uri` (moderate, via Fastify). Frontend: 0. Run `npm audit fix` and test; `zod` needs a minor upgrade (4.6.7). Wire `npm audit --omit=dev` into CI (a CI file exists from Module 14).
**Status — 🟡 2 of 3 fixed 2026-11-07; 1 accepted pending the Prisma 7 upgrade.**
- ✅ **`zod` upgraded 3 → 4.6.7.** This was a *major* upgrade, not the minor one stated above.
  - No code changes were needed apart from replacing the deprecated `ZodError.flatten()` with `z.flattenError()` in `app.ts` and `env.ts`.
  - The API's validation-error body is unchanged: `{ error: "validation_error", message, details: { field: [...] } }`.
  - All 28 suites pass (872 checks).
- ✅ **`fast-uri` patched** to 3.1.9 / 4.2.3 via a non-breaking `npm audit fix`.
- ⏸ **`deepmerge-ts` (`prisma` → `@prisma/config`): accepted, not reachable.**
  - It runs only inside the Prisma *CLI's* config loader, merging our own config files during `prisma migrate` / `prisma generate`.
  - Neither application code nor the runtime `@prisma/client` loads it, so no request can reach it.
  - The only fix is Prisma 7, a major migration (new `prisma.config.ts`, driver adapters, generator changes) to plan as its own task.
- **CI audit gate not yet added:** `npm audit --omit=dev --audit-level=high` would fail on the accepted `deepmerge-ts` item until Prisma 7. Add the gate together with that upgrade.

---

## 4. Low severity / hardening

- ✅ **Fixed 2026-11-09** (`check:low-hardening`) **L-1 CSV injection** — `audit.service.ts:160-164` quotes cells but does not neutralise a leading `= + - @ \t \r`. `actorName` (user-controlled full name) is exported raw. Prefix such cells with `'`.
- **L-2 External-link audit** — `sharing.service.ts:634-657` logs link opens with `actorUserId = sharer`; a viewer's activity looks like the sharer's. `fetchLinkFile` (the actual download) writes no audit event and bypasses the `openedCount`. Add an `actorType = external` and log the file fetch and download separately (with IP / user agent).
- **L-3 Search permission** — `search.routes.ts` gates on `search.search` only; `searchDocuments` filters by hidden folders but not by `documents.view`. Add `documents.view` to the gate or the dependency map (`permissions.ts` PERMISSION_DEPENDENCIES: `search.search → documents.view`).
- **L-4 Account enumeration** — login returns a distinct 403 `account_disabled` *before* the password check (`auth.service.ts:294`), and unknown emails skip the argon2 verification (faster response). Register intentionally reveals "email already registered" (Spec §2B.2) — keep rate limit. Add a dummy hash verification for unknown users and check password before revealing disabled status.
- **L-5 Refresh token handling** — a reused (already revoked) refresh token returns 401 but does not revoke the whole token family; the find-then-update in `refresh` is non-atomic so two concurrent refreshes both succeed. Use `updateMany … where revokedAt null` and check `count`; on reuse, revoke all tokens of that user/device.
- **L-6 Invite-code race** — `auth.service.ts:215-236` reads `usedCount` then increments, outside a transaction, and increments before the organisation is created (a failed creation burns a use). Use a conditional `updateMany` and create in one transaction.
- **L-7 Dev compose** — `docker-compose.yml:9,22-23` publishes Postgres/Redis with default credentials (`dms`/no password) on all interfaces. Bind to `127.0.0.1`. Production compose is good (no host ports for DB/Redis; passwords required).
- **L-8 Destructive test scripts** — `backend/scripts/check-*.ts` and `_backfill.mts` use whatever `DATABASE_URL`/`.env` is loaded and call `deleteMany` (including on audit events). Add a hard guard (`if NODE_ENV==="production" || DATABASE_URL doesn't contain "_test"` → exit) and move `_backfill.mts` (hard-coded `C:/apps/DMS/.env` path) out of the repo root or into `scripts/`.
- ✅ **Fixed 2026-11-09** (`check:low-hardening`; `iss`/`aud` not added) **L-9 JWT** — `lib/jwt.ts` verifies with the default algorithm set; pin `algorithms: ["HS256"]`, and add `iss`/`aud` for future-proofing.
- **L-10 Rate limiting** — only unauthenticated endpoints are limited (`lib/rate-limits.ts`, deliberately). Add per-user limits on `POST /…/search`, uploads, `/audit/export`, `/organizations/current/users`.

---

## 5. What was checked and is in good shape

- **Single permission engine**; `requirePermission` returns the same 403 for "no permission", "not a member" and "confidential non-member" (no existence leak); documents a viewer cannot see report 404 (`document.service.ts:227-253`).
- **Super Admin is not a blanket reader** (`effective-permissions.ts:63-80`) and is excluded from confidential folders (`:232`).
- **Tenant (organisation) isolation:** every service query pairs the ID with `organizationId` (spot-checked every `findUnique/update/delete` by ID; those without the filter always follow an organisation-scoped read). Search SQL is parameterised (`Prisma.sql`), tsquery input is sanitised to `[a-z0-9]`.
- **Confidential:** hidden-folder exclusion in listing, search, trash, needs-details; confidential audit events segregated and flagged centrally (`lib/audit.ts`); external links blocked at creation.
- **Auth:** argon2id; reset/verification/invite/refresh tokens are 256-bit random and stored hashed; refresh rotates; `reset-password` revokes all sessions; httpOnly + Secure(prod) + SameSite=Lax refresh cookie; access token kept in memory only; login lockout; rate limits on public endpoints; production refuses a weak `JWT_ACCESS_SECRET`.
- **Storage credentials** encrypted at rest (`STORAGE_CREDENTIALS_KEY`); storage keys are `orgId/uuid`, not user input; all access through the driver abstraction.
- **Legal Hold / trash:** all destruction paths go through `moveDocumentToTrash` / `destroyTrashedDocument`, both hold-checked; `uploadedAt` has a DB trigger.
- **Frontend:** no `dangerouslySetInnerHTML`/`eval`; no tokens in `localStorage` (only the organisation ID); 0 npm advisories.
- **Edge/proxy (Caddy):** HSTS, `nosniff`, `X-Frame-Options`, referrer & permissions policy, body size cap; production compose publishes only 80/443.

---

## 6. Recommended fix order

1. **H-1 + H-2** (one change in the resolver + helper, plus a trimmed share response) and its regression tests.
2. **H-3 + M-7** (role escalation).
3. **H-4** (re-check on link open, revoke on confidential move).
4. **M-1** (DB trigger + least-privilege DB role) and **M-2**/**M-3** (session and lockout).
5. **M-4** (storage allow-lists), **M-5** (magic-byte check, streaming, scanner).
6. **M-6, M-8**, then the Low items; wire `npm audit` and the access-matrix scripts into CI.

## 7. Next audit steps (not yet covered)

- **Dynamic verification:** run the API against a disposable DB and execute the H-1…H-4 recipes; extend `check-access-matrix.ts` with a "same org, wrong department" matrix for every route.
- **Infrastructure:** review `deploy/Caddyfile` end-to-end (TLS, CSP; the `Content-Security-Policy` is intentionally narrow), host firewall, backup encryption and restore test, secrets management, Docker image hardening (non-root, read-only FS), log redaction.
- **Frontend:** CSP tightening for blob-iframe PDF previews, sandboxing the preview iframe, clipboard/QR handling.
- **Business-logic abuse:** concurrency (double-submit, race on purge vs hold), large-organisation performance DoS (e.g. `confidentialFolderIdsToExclude` loads every folder in the org per request).
- **Compliance:** DPDP Act 2023 mapping (consent, deletion requests vs Legal Hold, breach notification), data-retention of `login_attempt` and IP addresses.
