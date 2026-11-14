# 05 — Backend modules and functions

Every module lives in `backend/src/modules/<name>/` as `*.routes.ts` (HTTP) + `*.service.ts` (logic) (+
`*.schemas.ts`). Endpoints are documented in the [API Reference](../API_Reference.md); this chapter documents the
**functions** behind them — what each does, the rules it enforces, and the audit event it writes.

Common signature: `fn(deps, actor, …)` where `deps = { prisma, env?, redis? }` and
`actor = { userId, organizationId, isSuperAdmin }`. Errors are thrown as `<Module>Error(status, code, message)`.

---

## 1. `lib/` — shared building blocks

### `lib/effective-permissions.ts` — the permission engine
| Export | Purpose |
|---|---|
| `resolveEffectivePermissions(prisma, actor, departmentId, folderId?)` | The resolution algorithm (chapter 04 §4). Returns `{ permissions, source, isConfidential, roleId? }`. |
| `hasPermission(prisma, actor, departmentId, key, folderId?)` | Boolean shortcut. |
| `canGrantRole(prisma, actor, departmentId, rolePermissions)` | Actor holds every `true` key in the map (Super Admin: always). |
| `confidentialFolderIdsToExclude(prisma, actor, departmentId?)` | Vault folder ids the actor isn't named on (all vaults for Super Admin). For counts that must still include vaults, don't use it. |
| `unviewableFolderIdsToExclude(prisma, actor, departmentId)` | Vaults + folders whose override withholds `documents.view`. **Use for every listing/search.** |
| `isConfidentialOwner(prisma, actor, folderId)` | Owner on any confidential ancestor. |
| `PermissionActor`, `EffectivePermissions`, `PermissionSource` | Types. |

### `lib/permissions.ts` — the catalogue
`PERMISSION_CATALOGUE`, `ALL_PERMISSION_KEYS`, `PERMISSION_DEPENDENCIES`, `DEPARTMENT_ADMIN_CAPABILITY_KEYS`,
`emptyPermissionMap()`, `permissionMapFrom(keys)` (map + dependency closure), `applyPermissionDependencies(map)`,
`findDependencyViolations(map)`, `hasDepartmentAdminCapability(perms)`, `grantsPermission(perms, key)`,
`isKnownPermissionKey(key)`.

### `lib/share-access.ts`
`resolveSharedAccess(prisma, actor, { id, organizationId })` → `{ permission: "view" | "download" } | null` — the
strongest active, unexpired, accepted share reaching the actor directly or via a department they're an
**active** member of. External links are excluded (resolved by token instead).

### `lib/legal-hold.ts`
| Export | Purpose |
|---|---|
| `activeHoldsCovering(db, orgId, { id, departmentId, folderId })` | Holds on the document itself or any folder up its chain. |
| `isUnderLegalHold(db, orgId, doc)` | Boolean. |
| `inheritedFolderHolds(db, orgId, folderId)` | Active holds on strict ancestors (used by folder move). |
| `folderAndAncestors(db, orgId, folderId)` | Folder ids up to the root. |
| `loadHoldIndex(db, orgId, departmentId)` | Resolve a department's holds once → `{ isHeld(doc), coveredFolderIds, … }` for bulk checks (daily run, listings, search). |
| `legalHoldAuthority(prisma, actor, departmentId, folderId)` | `"allowed" | "forbidden" | "not_found"`: vault → owner only; else `retention.manage_legal_hold`. |
| `AUTO_DELETE_TRASH_REASON`, `RESTORED_AFTER_AUTO_DELETE_REASON` | The two fixed reason strings. |

### `lib/audit.ts`
`logAuditEvent(prisma, { organizationId, actorUserId | SYSTEM_ACTOR, action, documentId?, departmentId?, targetDescription?, isConfidential? })`
— the only writer. Marks the event confidential when the document's folder is confidential (whatever the caller
passed). `SYSTEM_ACTOR` = `"system"` → `actorType = system`, `actorUserId = null`. `auditActorName(event)` →
name or "System". **There is no update/delete function and there must never be one.**

### Other libs
| File | Exports |
|---|---|
| `document-ref.ts` | `generateDocumentRef(tx, { organizationId, departmentId, documentTypeId, idPrefix, idCode, year })` → `PREFIX-CODE-YYYY-NNNNN` (5+ digits). Must run inside the create transaction. |
| `search-vector.ts` | `refreshDocumentSearchVector(db, documentId)`, `refreshAllDocumentSearchVectors(db)`. |
| `upload-formats.ts` | `ACCEPTED_FORMATS` (PDF, JPEG, PNG, DOCX, XLSX, Markdown, plain text), `ACCEPTED_EXTENSIONS`, `resolveFormat(mime, name)` (claim; extension decides within the text family), `detectFormat(buffer)` (binary evidence), `isPlainText(buffer)` (text evidence), `extractPlainText(buffer)`, `verifyUploadFormat(mime, name, buffer)` → `{ ok, format }` or `{ ok:false, code }`, `contentTypeHeader(mime)` (adds `charset=utf-8` for text), `MAX_EXTRACTED_TEXT_CHARS`. `ocr` per format: `image` / `pdf` (OCR worker), `text` (stored at upload), `none`. |
| `upload-limiter.ts` | `UploadLimiter(maxTotal, maxPerUser).tryAcquire(userId)` → `{ ok, release }`. |
| `queue.ts` | `OCR_QUEUE_NAME`, `RETENTION_QUEUE_NAME`, `RETENTION_SCHEDULER_ID`, `getOcrQueue(env)`, `enqueueOcr(env, versionId)` (best-effort, 2 attempts), `createQueueConnection(env)`, `dailyCronPattern("02:00")`. |
| `crypto.ts` | `encryptJson(env, value)` / `decryptJson(env, payload)` — AES-256-GCM, `iv(12)|tag(16)|ciphertext` base64. |
| `jwt.ts` | `signAccessToken(env, payload)`, `verifyAccessToken(env, token)`. |
| `tokens.ts` | `issueToken()` → `{ raw, hash }`, `hashToken(raw)`. |
| `password.ts` | `hashPassword`, `verifyPassword` (argon2id). |
| `mailer.ts` | `sendMail(env, { to, subject, text })` (Brevo, 3 attempts on network errors; console fallback; `MAIL_DISABLED`), `sendVerificationEmail`, `sendPasswordResetEmail`. |
| `calendar.ts` | Time-zone date maths: `localDate`, `startOfLocalDate`, `zonedTimeToInstant`, `addDays`, `isIsoDate`, `isLeapYear`, `isValidTimeZone`, `nextDailyRun`, `autoDeleteDueDate`, `autoDeleteUploadCutoff` (29 Feb → 1 Mar in a common year). |
| `rate-limits.ts` | `RATE_LIMITS.sensitive / login / publicRead`. |
| `prisma.ts`, `redis.ts` | The shared Prisma client; `createRedis(env)`. |

### `plugins/authenticate.ts`
Decorates `authenticate`, `requireVerifiedEmail`, `requireOrganization`, `requireSuperAdmin`,
`requirePermission(key, extractor?)`. The default extractor reads `departmentId` / `folderId` from params, then
body. Custom extractors: `folderTargetFromQuery` (document listing), `departmentOnlyTarget` (folder overrides),
the move-destination extractor (folder move).

---

## 2. `auth`

| Function | Rules / behaviour | Audit |
|---|---|---|
| `register(deps, {fullName,email,password}, ctx)` | Unique email; argon2id; verification token + email; refresh token; unverified access token. | — |
| `verifyEmail(deps, token)` | Single use, unexpired; sets `emailVerifiedAt`. | — |
| `resendVerification(deps, userId)` | Refuses if verified; invalidates old tokens. | — |
| `createOrganization(deps, userId, {name, industry?, inviteCode?})` | Signup mode gate; invite code validated + `usedCount++` (non-atomic, L-6); caller = owner. | `config_change` |
| `login(deps, {email,password}, ctx)` | Lockout (pair + account), disabled check, verify, records `login_attempt`, auto-selects a single org. | — |
| `selectOrganization(deps, userId, orgId)` | Must own or be an active member. | — |
| `me(deps, userId)` | User + organizations. | — |
| `refresh(deps, raw, ctx)` | Valid/unexpired/unrevoked; disabled account → revoke all; rotate; re-scope to org if still a member. | — |
| `logout`, `logoutAll`, `forgotPassword`, `resetPassword` | See API reference §4. Reset revokes all sessions. | — |
| `issueRefreshToken`, `refreshCookieOptions`, `REFRESH_COOKIE_NAME` | Shared with the invitation module. | — |

## 3. `organization`

| Function | Rules | Audit |
|---|---|---|
| `getOrganization(deps, orgId)` | — | — |
| `updateOrganization(deps, orgId, actorId, input)` | name, industry, subfolderDepthLimit, timeZone | `config_change` |
| `getDashboard(deps, orgId)` | Counts only; vaults included in counts; storage is org-level only. | — |
| `listMembers(deps, orgId)` | Owner + every membership grouped by user. | — |
| `listOrgUsers(deps, orgId)` | id/name/email only — for pickers. | — |
| `setMemberEnabled(deps, orgId, actorId, userId, enabled)` | Flips all of the user's memberships in this org; never the owner. | `member_change` |
| `resetMemberPassword(deps, orgId, actorId, userId)` | Sends the standard reset email. | `member_change` |

## 4. `storage`

| Function | Rules | Audit |
|---|---|---|
| `getActiveStorageDriver(deps, orgId)` | **The only way feature code reaches storage.** Decrypts credentials, applies the target policy, builds the driver. | — |
| `getStorageStatus(deps, orgId)` | No secrets. | — |
| `testAndSaveStorageConfig(deps, orgId, actorId, input)` | Policy → round-trip test → encrypt → upsert. A failure saves nothing. | `config_change` |
| `retestStorageConfig(deps, orgId, actorId)` | Re-test saved config; records `status` and `lastTestedAt`. | `config_change` |
| `recordStorageUsage(deps, orgId, deltaBytes)` | Adjusts `usedBytes`. | — |

`storage.policy.ts`: `assertStorageTargetAllowed(env, input)`, `isWithin(parent, child)`, `StorageTargetError`.
Drivers (`drivers/`): `StorageDriver` = `testConnection()`, `put(key, buffer, contentType?)`, `get(ref)`,
`delete(ref)`. `NasDriver` (fs; keys confined to the mount) and `R2Driver` (S3 SDK; checksum headers only when
required, as R2 rejects the newer defaults).

## 5. `department`

| Function | Rules | Audit |
|---|---|---|
| `listTemplates()` | The six templates with full role maps. | — |
| `listDepartments(deps, actor)` | SA: all; others: departments with an active membership. With member/document counts. | — |
| `getDepartment(deps, actor, id)` | `documents.view` or `members.change_role`. | — |
| `listAddableMembers(deps, actor, id)` | `members.invite`; org users not yet here; the owner is a candidate except for themself. | — |
| `createDepartment(deps, actor, input)` | SA (route). Validates types/roles/members; one transaction creates dept, roles, types+fields, memberships and a **General** folder. Creator not added. | `config_change` |
| `updateDepartment(deps, actor, id, input)` | name/status: SA only; else `configuration.edit_rules`; prefix uniqueness. | `config_change` |
| `createDocumentType` / `updateDocumentType` / `deleteDocumentType` | `configuration.*_document_type`; title-field and option rules; can't remove a field with values; can't delete a used or the last type. | `config_change` |
| `createRole` / `copyRole` / `updateRole` / `deleteRole` | `members.change_role` + within reach (H-3); dependency validation; keep an admin-capable role; system roles undeletable; role in use undeletable. | `role_change` (create/copy/delete), `permission_change` (update) |
| `addMember(deps, actor, deptId, userId, roleId)` | `members.invite` + `canGrantRole`; user must be in the org; one role per department. | `member_change` |
| `changeMemberRole(…, userId, roleId)` | `members.change_role` + can grant the new role + target within reach (M-7) + not the last admin. | `role_change` |
| `removeMember(…, userId)` | `members.remove` + target within reach + not the last admin. Deletes the membership only. | `member_change` |
| `assertDepartmentPermission(deps, actor, deptId, key)` | Exported helper: dept exists in org + engine grants `key`. | — |

`department.templates.ts`: `DEPARTMENT_TEMPLATES`, `findTemplate(key)`, `templateRolePermissions(role)`,
starter key sets `STAFF_KEYS`, `MANAGER_KEYS`, `AUDITOR_KEYS`, Department Admin = every R1-active key.

## 6. `invitation`

| Function | Rules | Audit |
|---|---|---|
| `listInvitations(deps, orgId, deptId?)` | Pending only, with names and `isExpired`. | — |
| `createInvitation(deps, actor, deptId, {email, roleId})` | Inviter can grant the role; not already a member; no pending invite for the address; 7-day token; email. | `member_change` |
| `resendInvitation`, `revokeInvitation` | Pending only; resend rotates token + clock. | `member_change` |
| `previewInvitation(deps, rawToken)` | Status checks (marks expired); `hasAccount`. | — |
| `acceptInvitation(deps, rawToken, {fullName?, password?}, authedUserId?, ctx)` | Existing account must be signed in as that email; new account created **verified** with a session; membership + invitation update in one transaction. | `member_change` |

## 7. `folder`

| Function | Rules | Audit |
|---|---|---|
| `listFolders(deps, actor, deptId)` | Hides vaults the actor isn't on and their subtrees; adds counts and hold state. | — |
| `folderPath(deps, actor, folderId, deptId?)` | Root → folder; refuses hidden folders. | — |
| `createFolder(deps, actor, deptId, input)` | Depth limit; sibling-unique name; vault creation (owner + seed members); children of vaults are confidential. | `config_change` |
| `renameFolder` | Sibling-unique. | `config_change` |
| `moveFolder(deps, actor, folderId, newParentId, deptId?)` | Not into own subtree; depth of whole subtree; name clash; can't leave an inherited hold; confidentiality propagates down. | `config_change` |
| `deleteFolder` | No subfolders, no documents (incl. trash), no active hold. | `delete` |
| `myPermissions(deps, actor, deptId, folderId?)` | Engine result + role name + depth limit + hold authority. | — |
| `listFolderPermissions`, `setFolderPermission`, `clearFolderPermission` | Overrides: restrict-only; not on vaults; role must be the folder department's. | `permission_change` on set (⚠ `clearFolderPermission` writes no audit event — gap) |

All take an optional trailing `departmentId` that binds the folder to the URL's department (H-1).

## 8. `document`

| Function | Rules | Audit |
|---|---|---|
| `createDocument(deps, actor, input)` | Folder in org; type belongs to the folder's department; field validation (`allowIncomplete` for uploads); mints `documentRef`; creates doc + v1 + values; refreshes search vector. | `upload` |
| `addVersion(deps, actor, docId, {file, changeNote})` | `documents.upload_version`; not in trash; next version number; becomes current. | `upload` |
| `restoreVersion(deps, actor, docId, versionId)` | `documents.upload_version`; copies forward as a new version (same storageRef). | `restore` |
| `editMetadata(deps, actor, docId, values)` | `documents.edit_metadata`; replaces values; re-derives title; re-index. | `edit` |
| `getDocument(deps, actor, docId)` | Engine → share fallback; shaped by permissions (H-2); hold state; activity. | `view` |
| `getDocumentActivity` | `documents.version_history`; last 50 events. | — |
| `getDocumentFile(deps, actor, docId, versionId?, mode)` | preview/download permission; older versions need history. | `download` (downloads only) |
| `lookupByRef(deps, actor, ref)` | Exact `documentRef`; 404 if not viewable. | — |
| `listFolderDocuments(deps, actor, folderId, deptId?)` | Active docs in the folder (folder bound to dept). | — |
| `findDuplicatesInDepartment(deps, actor, deptId, checksum)` | Matching checksums the actor can view. | — |
| `listNeedsDetails(deps, actor, deptId)` | Missing required values; hidden folders excluded. | — |
| `moveDocumentToTrash(…)` | **The one soft-delete path** (user delete and auto-delete). Refuses held documents; conditional on still active (idempotent). | `delete` or `auto_delete` |
| `deleteDocument(deps, actor, docId)` | `documents.delete` → `moveDocumentToTrash`. | `delete` |
| `listTrash(deps, actor, deptId)` | Trash items with countdown, hold state and per-item rights. | — |
| `restoreDocument(deps, actor, docId)` | `documents.restore`; auto-deleted needs hold authority and places a hold. | `restore` (+ `legal_hold_placed`) |
| `destroyTrashedDocument(…)` | **The one destruction path** (purge, empty trash, automatic purge). Refuses held; deletes files via the driver, then rows. | `purge` |
| `purgeDocument`, `emptyTrash` | Department Admin; in trash; skip held. | `purge` |
| `TRASH_RETENTION_DAYS` | 30. | — |

Internals worth knowing: `loadDocumentAccess` (load + permission map + `viaShare`), `resolveDocumentPermissions`
(engine then share fallback; never via share for confidential), `shapeDocument(doc, view)`,
`validateFieldValues` (types: date `YYYY-MM-DD`, number, dropdown option), `documentHoldState`.

## 9. `upload`

| Function | Rules | Audit |
|---|---|---|
| `uploadDocument(deps, actor, input)` | Folder bound to dept → size → content verification → checksum → duplicate prompt (`409 duplicate_detected`) unless `onDuplicate` → store via driver → `createDocument` / `addVersion` → enqueue OCR (images/PDFs only, `needsOcr`). Text files get `ocrText` + `ocrStatus: done` at upload (`ocrFields`). Stored object removed if the DB write fails. | via document (`upload`) |
| `uploadNewVersion(deps, actor, docId, file, note?)` | Same verification → `addVersion`. | `upload` |
| routes: `parseSingleUpload`, `withUploadSlot` | Multipart parsing; concurrency slot taken **before** reading the body and always released. | — |

## 10. `search`

`searchDocuments(deps, actor, params)` builds one parameterised SQL query (`Prisma.sql`): org + department +
active + not in `unviewableFolderIdsToExclude` + optional type + Upload Date bounds (org time zone) + optional
"uploaded by me" + text (`to_tsquery` prefix terms OR `documentRef ILIKE`) + one `EXISTS` per field filter.
Ordered by `ts_rank` then `updatedAt`, limit ≤ 200, then hydrated through Prisma in rank order with hold state.
`validateUploadDateRange(from?, to?)`. `buildPrefixTsquery` strips everything but `[a-z0-9]` — this is what makes
user input safe inside `to_tsquery`.

## 11. `sharing`

| Function | Rules | Audit |
|---|---|---|
| `createShare(deps, actor, docId, input)` | Sharer must view the doc + `sharing.share`; download needs `documents.download`; per-type rules (chapter 04 §7); link token hashed; expiry 1–365 days. | `share` |
| `listSharedByMe`, `listSharedWithMe` | Outbox (revoked kept as history) / inbox (active, accepted, unexpired, undismissed). Both first run `purgeExpiredShares`. | — |
| `listDocumentShares` | `sharing.share` on the doc. | — |
| `updateShare`, `revokeShare` | Only the creator; links must keep an expiry. | `share` |
| `dismissShare` | Only the direct recipient; view preference. | — |
| `listPendingForDepartment`, `respondToCrossDepartmentShare` | Receiving department's consent. | `share` |
| `openLink(deps, rawToken)`, `fetchLinkFile(deps, rawToken, mode)` | `resolveLink` re-validates everything on every call (H-4). | `link_access` |
| `purgeExpiredShares` (internal) | **Deletes** the org's `active` shares whose `expiresAt` has passed; runs every time `listSharedByMe` / `listSharedWithMe` loads. Expired shares grant nothing even before this runs (access checks compare `expiresAt`). The share's audit event remains. | — |

## 12. `confidential`

| Function | Rules | Audit |
|---|---|---|
| `listMembers(deps, actor, folderId)` | On the list; returns `canManage` (owner). | — |
| `addMember`, `removeMember` | **Owner only** (`requireVaultOwner`); owner can't be removed. | `permission_change` (confidential) |
| `listOrphaned`, `listRecoveries` | SA or Department Admin of the department. | — |
| `initiateRecovery(deps, actor, folderId, newMemberUserId)` | Vault must have no members; one in-progress recovery. | `permission_change` |
| `approveRecovery(deps, actor, recoveryId)` | Records SA and/or DA approval; two distinct people; completes by making the nominee owner. | `permission_change` |

## 13. `retention`

| Function | Rules | Audit |
|---|---|---|
| `getAutoDeleteSetting`, `previewAutoDelete` | `retention.manage_auto_delete`. | — |
| `setAutoDeletePeriod(deps, actor, deptId, {autoDeleteYears, confirm?})` | 1–100 or null; set/shorten needs confirm; conditional update (`setting_changed`). | `retention_change` |
| `listUpcomingDeletions` | `retention.view_upcoming_deletions`; next 30 days; hidden folders excluded; held marked. | — |
| `listHolds` | `retention.manage_legal_hold`. | — |
| `placeDocumentHold`, `placeFolderHold`, `removeHold` | Hold authority; reason required ≤500; one active hold per target. | `legal_hold_placed` / `legal_hold_removed` |
| `runAutoDelete(deps, opts)` | Daily: per department with a period, active docs due by today (org zone), skip held, batches of 200, per-doc failures isolated. System actor. | `auto_delete` |
| `runTrashPurge(deps, opts)` | Daily: trash older than 30 days, skip held → `destroyTrashedDocument`. | `purge` |
| `runDailyRetention(deps)` | auto-delete then purge. | — |
| `nextRun(env, tz)`, `UPCOMING_WINDOW_DAYS` | Schedule helpers. | — |

## 14. `audit`

`listAudit(deps, actor, deptId, filters)` and `exportAudit(…)` — see API reference §16. Confidential events only
with `audit.view_confidential_audit`; export needs `audit.export_audit`; CSV limited to 1000 rows.

## 15. Workers

| Worker | Behaviour |
|---|---|
| `worker/ocr.worker.ts` | BullMQ `ocr`, concurrency 2. Loads the version, reads bytes through the storage driver, extracts text (Tesseract for images only when `OCR_IMAGES_ENABLED=true` — off in production and never queued then; pdf-parse for PDFs up to `OCR_MAX_PAGES`, none for Office), caps at 1,000,000 chars, writes `ocrStatus`/`ocrText`, refreshes the search vector. Any failure → `ocrStatus = failed` (not retried; the document stays searchable by metadata). |
| `worker/retention.worker.ts` | Registers one job scheduler (`daily-retention`, cron from `RETENTION_JOB_TIME` in `RETENTION_JOB_TIME_ZONE`) and runs `runDailyRetention`, concurrency 1, no automatic retry. `--once` runs immediately without Redis and exits. |
