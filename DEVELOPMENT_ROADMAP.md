# DMS Development Roadmap — Module by Module, Start to End

**Purpose:** the single working plan for building Release 1 of the DMS. Everything here is derived from `docs/DMS_Scope_and_MVP_Definition.md` (scope authority), `docs/DMS_Product_Requirements_Document (1).md` (requirement IDs + acceptance criteria), `docs/DMS_Data_Model.md` (schema, already implemented in `backend/prisma/schema.prisma`) and `docs/DMS_Feature_and_Flow_Specification.md` (flows/screens). Where this roadmap and those documents ever disagree, **the docs govern** — fix this file, not your understanding of the docs.

**This is a living document.** Every time a step below is completed:
1. Flip its status marker (⬜ → 🔧 → ✅).
2. Add a one-line dated note under that step (`- [x] 2026-07-24: schema builder API done, see each_update.md`).
3. Write the detailed narrative in `each_update.md` as already practiced — this file stays a scannable checklist, `each_update.md` stays the detailed diary.
4. If a design ambiguity comes up that the docs don't resolve, flag it in the relevant step rather than guessing — this project has many deliberately-decided edge cases (see CLAUDE.md "Hard rules").

**Status legend:** ⬜ Not started · 🔧 In progress · ✅ Done · 🚫 Blocked (reason noted)

---

## 0. Current state snapshot (as of 2026-07-22)

**Database schema — ✅ fully modeled.** `backend/prisma/schema.prisma` already implements essentially the entire Data Model doc: `Organization`, `User`, `Membership`, `Department`, `Role`, `Folder`, `FolderPermission`, `Document`, `DocumentRefSequence`, `Version`, `DocumentType`, `FieldDef`, `FieldValue`, `Share`, `ConfidentialMember`, `AuditEvent`, `StorageConfig`, `RefreshToken`, `PasswordResetToken`, `EmailVerificationToken`, `Invitation`, `SignupSetting`, `SignupInviteCode`, `LoginAttempt` — one migration applied (`20260721124139_init`). This means **most modules below are "build the service/API/UI against an existing table," not "design a table."** Confirm the schema still matches the doc before each module (it may have drifted) rather than assuming it's untouched.

**Backend application code — only the auth module exists.** `backend/src/modules/auth/` (register, login, verify-email, resend-verification, forgot/reset-password, logout, refresh, `/auth/me`, signup-mode, create-organization, select-organization). Login lockout uses `LoginAttempt` (AUTH-7 ✅). **`AuditEvent` is not yet written anywhere, including by the auth module** — flagged as a gap to close in Module 1.5 below, since audit logging is supposed to start from day one per the Scope doc ("audit events are logged in v1 even though the viewer comes later").

**Frontend — only the auth flow + a placeholder dashboard.** Register, Login, Verify-email(+pending), Forgot/Reset password, Create-organization, Select-organization, a minimal Dashboard. Visual design pass done (2026-07-22, "Keystone" palette — see `each_update.md`). No department, folder, document, search, sharing, or audit screens exist yet.

**Update 2026-07-23:** Modules 1, 2 and 2.5 (the permission engine) are complete — the snapshot
above describes 2026-07-22 and is kept for history. Nothing below 2.5 has been started, except the
storage work already delivered in 1.1.

---

## 1. Build order and why

The order is dependency-driven, not priority-driven — each module needs the one before it to exist:

```
Auth (done) → Org completion → Department creation (schema builder, roles)
  → Permission engine (cross-cutting, needed by everything protected)
  → Storage abstraction (needed before real uploads)
  → Folders → Documents & Versioning → Upload & Capture (OCR)
  → Search → Document Viewer → Sharing → Confidential Folders
  → Trash & Recovery → Audit Viewer & Export
  → Non-functional hardening → Deployment
```

Folders need a Department (folder.department_id) and the permission engine (inheritance/overrides). Documents need a Folder and a DocumentType (from Department creation). Upload needs Documents *and* a working Storage driver. Search needs Documents to exist to index. The Viewer, Sharing, Trash and Audit-viewer all operate on Documents that already exist, so they come after. Audit *logging* itself is not a separate module — it's a cross-cutting instruction repeated in every module below (see Module 1.5).

---

## 2. Module 1 — Organization completion

**Status:** 🔧 In progress (Auth ✅, everything else in this module ⬜)
**Requirement IDs:** ORG-2, ORG-3, ORG-4, ORG-5, STO-1, STO-2, STO-3, STO-4
**Depends on:** nothing (auth already exists)

### 1.1 Storage setup & test-connection ✅
- [x] 2026-07-22: backend (`storage` module: driver interface + NAS + R2 drivers, AES-256-GCM
  credential encryption, `POST/GET /storage/config`) and frontend (`StorageSetupPage`, Dashboard
  status banner) done and tested end-to-end (both success and failure paths). See `each_update.md`.
- [x] 2026-07-22: confirmed working against **real Cloudflare R2 credentials** (not just the
  local NAS-path test) — fixed an AWS-SDK-v3/R2 checksum-header compatibility issue along the way.
- Backend: `StorageConfig` CRUD; storage abstraction interface skeleton (`testConnection()` per Section 6.1 of the Scope doc) with NAS and R2 drivers implementing connect → write → read-back → delete → pass/fail with specific mapped error messages (see Scope doc §6.1.1 table for the exact failure-message mapping — reuse it verbatim, don't invent new wording).
- Backend: credentials **encrypted at rest** (settle key-management approach here — this is an open item in the Data Model doc §12), never returned to the client, execution always server-side.
- Frontend: storage setup form that adapts fields to the chosen backend (NAS: mount path + SMB/NFS creds; R2: endpoint + bucket + access key/secret), "Test connection" button, setup blocked until `status = verified`.
- **Hard gate:** organization setup cannot complete until the test passes — no "save and fix later" state.

### 1.2 Organization settings ✅
- [x] 2026-07-22: `organization` module — `GET/PATCH /organizations/current` (name, industry,
  `subfolderDepthLimit`), Super-Admin-gated, audit-logged. Frontend `OrganizationSettingsPage`.
  Tested live against the real "Abate" org (patched then reverted the depth limit).

### 1.3 User directory (Super Admin) ✅ — completed 2026-07-23
- [x] 2026-07-22: `GET /organizations/current/members` (Super Admin + everyone else's active
  `Membership`s in this org), disable/enable (flips every `Membership` this user holds *within
  this org only*, per Data Model §7.3 — never touches the global `User.status`), reset-password
  (reuses the existing `forgotPassword` flow), all Super-Admin-gated and audit-logged. Guardrail:
  the org's Super Admin (creator) can't be disabled — there's no platform admin to recover them.
  Frontend `UserDirectoryPage`. Tested live: seeded a throwaway department/role/membership via
  Prisma directly (no UI exists yet to create one), exercised list/disable/enable/reset-password
  end to end, confirmed audit events, then deleted the throwaway data.
- [x] 2026-07-23: **invite-by-email completed.** `invitation` module — invite (email + role),
  preview, accept, resend (rotates the token), revoke; mounted under
  `/departments/:departmentId/invitations` so every route gates on the Module 2.5 engine
  (`requirePermission("members.invite")`), plus a read-only org-wide list for the directory.
  An existing account must sign in to accept (the link proves the inbox, not the account); a new
  account is created already email-verified and signed straight in. 24 API assertions passing,
  including a Staff member being refused. Frontend: invite form + pending list on the department
  Members tab, outstanding invitations in the user directory, public `/invitations/:token` accept
  page, and Onboarding step 3 is real. See `each_update.md`.
- **Original dependency note, now resolved:** `ORG-3` ("assign a user to a department
  with a role") and the `Invitation`-based invite flow **cannot be built yet** — `Invitation` and
  `Membership` both require a real `departmentId`/`roleId` (Module 2 doesn't exist yet), so an
  invite form today would have nothing to target. Deferred invite/accept-invitation/remove-from-
  department to right after Module 2 ships at least one department+role — building it now would
  mean an untestable form with an empty dropdown. The member list, disable/enable, and
  reset-password above are genuinely complete and don't have this problem.
- **Bonus fix while testing this:** found that Fastify's own request-parsing errors (bad
  JSON, wrong content-type) were being flattened to a generic 500 by the global error handler,
  hiding their real 4xx status — fixed in `app.ts` (now surfaces `err.statusCode` for any
  4xx-range error before falling back to 500). Unrelated to storage/org code specifically, just
  surfaced while testing against it.

### 1.4 First-run onboarding ✅
- [x] 2026-07-22: `OnboardingPage.tsx` — 3-step guided flow reached right after org creation
  (`CreateOrganizationPage` → `/onboarding`, or via `VerifyEmailPendingPage` if they verify
  *after* creating the org — that path only fires once ever, since email verification is
  single-use, so it's the correct one-time hook). Step 1 (Storage) is real and hard-gated —
  extracted the storage form into a shared `StorageConnectionForm` component used by both this
  flow and the standalone `/storage-setup` settings page; auto-skips to step 2 if storage was
  already verified. Steps 2 (department template picker) and 3 (invite people) are honest
  placeholders — both genuinely blocked on Module 2 (same dependency noted under 1.3) — with a
  "Continue"/"Skip to dashboard" path so the flow never traps anyone. Gated to Super Admin only
  (`<Navigate>` redirect for anyone else who reaches the route directly).

### 1.5 Audit logging groundwork ✅ — cross-cutting
- [x] 2026-07-22: `logAuditEvent()` helper built (`backend/src/lib/audit.ts`, append-only by
  construction — only exports a create) and wired into storage-config save, organization
  settings update, member disable/enable/reset-password, and (2026-07-22) `createOrganization`.
- **Corrected understanding, not a remaining gap:** register, login, `resetPassword`,
  `verifyEmail`, and `resendVerification` genuinely **cannot** be audit-logged under the current
  schema — `audit_event.organization_id` is a required FK, and none of those actions have an
  organization to attach to (they're global-account actions, or in login's case there's no
  matching `AuditAction` enum value at all). This isn't a gap to close later; it's what the
  Data Model actually specifies (§8: the audit trail is an organization-scoped compliance
  surface). Every action that genuinely has an organization context now logs correctly.
- Backend: a small `logAuditEvent()` helper wrapping `AuditEvent.create`, called from **every** state-changing action from this point forward (login, register, org/department/role changes, folder/document actions later). Retrofit it into the existing auth routes (login, register, password reset, role/permission changes) as part of this module, since none of that is logged yet.
- No viewer UI yet (that's Module 12) — this step is purely "make sure the rows exist" so nothing needs retrofitting later.

### 1.6 Organization dashboard (thin) ✅
- [x] 2026-07-22: `GET /organizations/current/dashboard` (Super-Admin-gated) — department/user/
  document counts, org-wide storage used (from `StorageConfig.usedBytes`), live storage-
  connection status, per-department member/document counts. Confidential-folder documents are
  deliberately included in every count (no filter), never named. Frontend: four stat tiles +
  department list folded into `DashboardPage`. Tested live against the real "Abate" org (0
  departments, 1 user, 0 documents, r2/verified — all correct for its current real state).
- **Flagged gap:** Feature Spec §10A calls for a per-department *storage* count too, but the
  Data Model only tracks storage usage at the organization level in R1 (`storage_config` is one
  row per org — per-department storage is explicitly R2). Omitted rather than fabricated; only
  the org-wide total is real. Revisit if per-department storage tracking gets pulled into R1.

---

## 3. Module 2 — Department creation

**Status:** ✅ Done (2.6's auto-tagging half deferred with a stated reason — see that section)
**Requirement IDs:** DEP-1, DEP-2, DEP-3, DEP-4 (DEP-5 "save as template" is explicitly R2 — do not build)
**Depends on:** Module 1 (org must exist; storage need not be finished first, but onboarding flow expects it before this step)

### 2.1 Five-step wizard shell ✅
- [x] 2026-07-23: `DepartmentCreatePage` (5 steps: name+template → vocabulary → schema builder →
  roles+members → rules), `DepartmentsPage` (list), `DepartmentDetailPage` (Overview / Document
  types / Roles / Members tabs — the "all remains editable" half of DEP-1). Backend
  `backend/src/modules/department/` with `GET/POST /departments`, `GET/PATCH /departments/:id`,
  document-type CRUD, role create/copy/update/delete, member add/change-role/remove. All
  audit-logged. Onboarding step 2 and the Dashboard's departments panel now point at the real
  wizard. Verified via API **and** a full browser walkthrough. See `each_update.md`.

### 2.2 Templates ✅
- [x] 2026-07-23: all six shipped templates (Healthcare, Education, Accounts, HR, Legal, Blank) as
  plain data in `department.templates.ts` — document types, fields, vocabulary and starter roles,
  no sector branching anywhere, so DEP-5 (R2) can emit the same shape later without a rewrite.
  Starter Department Admin role deliberately excludes R2-inactive keys (workflow/reports), so
  turning Release 2 on never silently confers approval authority.

### 2.3 Vocabulary ✅
- [x] 2026-07-23: `subjectTerm` / `identifierTerm` on create and on the department's Overview tab,
  with the live preview the spec asks for (upload button, heading, search placeholder and empty
  state all re-render as you type). DEP-3 done.

### 2.4 Schema builder — document types & fields ✅ (the core of this module)
- [x] 2026-07-23: `DocumentType` + `FieldDef` CRUD, `sortOrder` derived from array order (the
  client reorders by moving elements, so there is no second source of truth to keep in sync).
  Enforced: exactly one title field per type, unique field labels per type, dropdowns must carry
  options and non-dropdowns must not, unique type name + ID code per department, the last document
  type can't be deleted, and a field already holding `field_value` rows can't be removed. Frontend
  `DocumentTypeEditor` (drag-to-reorder + arrow fallback, per-field controls, live sample document
  ID) is shared by the wizard and the department's Document types tab. DEP-2 done.

### 2.5 Roles & permissions defaults ✅
- [x] 2026-07-23: permission catalogue extracted to `backend/src/lib/permissions.ts` (Data Model §3
  keys, Feature Spec §2A.4 grouping, §2A.7 dependencies) and served at
  `GET /departments/permission-catalogue` so the client can't drift from what the server validates.
  Role create/copy/rename/update/delete, plus the `RoleMatrixEditor` UI. **Client auto-enables a
  parent when you tick a child; the server refuses an invalid combination rather than coercing it**
  — §2A.7 requires the refusal, so the UI's helpfulness is not the enforcement.
- [x] Guardrail done on all four paths that could break it: role edit, role delete, member role
  change, member removal. System roles are undeletable; a role still held by members can't be
  deleted.
- **Flagged, needs a call at some point:** the docs never define which catalogue keys constitute
  "Department Admin" (§2A.4's example matrix shows a "Create roles" row that has no corresponding
  key in Data Model §3 at all). Derived here from `members.change_role` + `configuration.edit_rules`
  — see `DEPARTMENT_ADMIN_CAPABILITY_KEYS`. Likewise `documents.restore` is documented as requiring
  "access to Trash", which is not a key that exists; mapped to `documents.view` until Module 11.

### 2.6 Rules — default sharing ✅ (auto-tagging deferred, see below)
- [x] 2026-07-23: **schema decision made with the user** — a `rules` JSON column on `department`
  (over a separate table), because rules are read as a whole at upload/share time and never
  queried or joined on individually. `docs/DMS_Data_Model.md` §2.4 updated **first**, then the
  migration (`20260723123008_department_rules`) — the doc governs field names, so the column
  follows it, never the reverse.
- [x] R1 shape: `{ defaultSharing: { externalLinksEnabled, linkExpiryDays } }`, Zod-validated,
  absent rules resolving to documented defaults. Templates carry it: every template starts closed
  except Legal (Feature Spec §3 Step 5). Frontend `RulesEditor` shared by the wizard's step 5 and
  a new Rules tab on the department page.
- **Auto-tagging deliberately deferred, with a sharper reason than "no storage":** both halves have
  no target yet — a tag label has no column on `document` at all, and folder-conditioned rules need
  folders (Module 4). When either lands it becomes another key in the same JSON, not a schema
  change. Revisit at Module 4/6.
- **Do not build retention, expiry-reminders, or workflow here** — Release 2, per CLAUDE.md.

---

## 4. Module 2.5 — Permission engine (cross-cutting core)

**Status:** ✅ Done (2026-07-23) — **amended the same day**: the Super Admin bypass was narrowed
on the user's instruction (see below), which deviates from Feature Spec §2A.1
**Requirement IDs:** underlies §9 of the PRD and 2A of the Feature Spec; gates FLD-3, CNF-1..5, and every "permission-driven" acceptance criterion across the rest of the PRD
**Depends on:** Module 2 (roles must exist to resolve)

This is infrastructure, not a screen — build it once, correctly, before any protected resource (folders, documents) needs it.

### Built 2026-07-23
- [x] `backend/src/lib/effective-permissions.ts` — `resolveEffectivePermissions(prisma, actor,
  departmentId, folderId?)` implementing the fixed order: role baseline → folder overrides
  intersect (restrict-only, every override on the path applies) → confidential folder ignores both,
  named list only, Super Admin excluded. Confidentiality is resolved by **walking the folder chain**
  rather than trusting a folder's own `isConfidential` flag, and the named list is read from the
  nearest confidential ancestor. External-share/create-link are forced off inside confidential
  folders at the engine level.
- [x] `confidentialFolderIdsToExclude()` for query-layer exclusion in listings/search/counts (the
  hard rule that this never be left to the UI). Returns ids rather than filtering counts, because
  aggregate counts legitimately include confidential folders (Data Model §8.1).
- [x] `app.requirePermission("documents.upload")` Fastify preHandler — one line per protected
  route, resolution cached on the request. Its 403 is identical whether you lack the permission,
  aren't a member, or are looking at a confidential folder you aren't named on, so it can't be used
  to probe for a folder's existence.
- [x] Module 2's `assertDepartmentPermission()` now **delegates** to the engine — the local copy is
  gone, not duplicated.
- [x] **Tested hard before moving on**, as this section demanded: `npm run check:permissions`
  (`backend/scripts/check-permission-engine.ts`) — 24 assertions against a real database with a
  throwaway folder tree, all passing, including "a fully permissive override cannot grant beyond
  the role", "Super Admin excluded from confidential", and "confidential inheritance into a child
  whose own flag is false". Port these to a test runner when one is chosen; don't rewrite them.
- [x] 2026-07-23 (amendment): **a Super Admin is no longer omnipotent inside a department.** With
  no membership they resolve to administrative keys only (`members.*`, `configuration.*`,
  `audit.view_audit`, `audit.export_audit`) — they can configure a department and manage who
  belongs to it, but cannot read its documents or folders until given a role like anyone else.
  With a membership they read through that role, plus those administrative keys. Folder overrides
  cannot strip the administrative keys. **This contradicts Feature Spec §2A.1 and §3 Step 4 (the
  creator is no longer auto-added as a member either) — the user overruled the spec deliberately
  for security, and those two sections should be amended to match.**
- **Flagged decision:** the docs never say which *capabilities* being on a confidential folder's
  named list confers (§11.1 defines it as an access gate only). Implemented as the member's own
  department role where they have one, and a documented read-only floor where they don't.
- **For Module 4:** folder creation must still set `isConfidential` on descendants of a confidential
  folder — the engine doesn't depend on it, but listings and search will read the flag directly.

**Head start from Module 2 (2026-07-23):** `backend/src/lib/permissions.ts` already holds the
catalogue, the dependency map, `applyPermissionDependencies`, `findDependencyViolations` and
`grantsPermission` — reuse them, don't re-derive. `department.service.ts`'s
`assertDepartmentPermission()` is a **narrow first slice** of the resolution rule (Super Admin
bypass → membership's role baseline) with no folder-override or confidential handling, because
neither exists yet. This module should **subsume and replace** that function, not sit beside it —
and must keep the baseline-then-restrict ordering intact.

- Backend: `resolveEffectivePermission(user, department, folder?)` implementing the fixed order: **role baseline → folder override may only restrict, never grant → confidential folder ignores both, named-list only, Super Admin excluded.** This exact order is a "Hard rule" in CLAUDE.md — do not reorder it.
- Backend: dependency enforcement (Feature Spec §2A.7) at the role-editor save path — enabling a child auto-enables its parent, and the editor must refuse to save an invalid combination rather than silently coercing it.
- Backend: a Fastify auth/permission decorator or hook so every future protected route is a one-line `requirePermission('documents.upload')`-style check, not hand-rolled logic per route.
- **Test this module hard before moving on** — every later module's access-control correctness depends on this one being right. A bug here is a tenant-isolation-grade bug.

---

## 5. Module 3 — Storage abstraction layer

**Status:** ✅ Done (2026-07-24) — confirmed complete and given its runtime accessor when Module 6 became its first real consumer
**Requirement IDs:** STO-3
**Depends on:** Module 1.1 (the interface shape was already sketched there)

- [x] 2026-07-24: confirmation pass — `put`/`get`/`delete`/`testConnection` are complete on both
  the NAS and R2 drivers, and a codebase grep confirms **no feature code imports a storage SDK or
  touches `node:fs` directly** (only the two driver files do). Added `getActiveStorageDriver(org)`
  and `recordStorageUsage(org, delta)` to the storage service — the single runtime seam Upload and
  the OCR worker read/write through, decrypting the saved credentials in one place. A real R2
  round-trip (put → get byte-identical → delete) is exercised by `npm run check:upload`.
- Backend: finalize the storage interface (`put`, `get`, `delete`, `testConnection`) with NAS and Cloudflare R2 drivers behind it. Every `version.storage_ref` is opaque — **never** a raw path, per CLAUDE.md's hard rule ("Storage access only through the abstraction layer... never call a storage SDK directly from feature code").
- No feature code anywhere in the app may import an S3/R2 client or touch a filesystem path directly — always through this interface.

---

## 6. Module 4 — Folders

**Status:** ✅ Done (2026-07-25) — folder CRUD, tree, workspace, and `FolderPermission` overrides all live
**Requirement IDs:** FLD-1, FLD-2, FLD-3, FLD-4
**Depends on:** Module 2 (department must exist), Module 2.5 (permission engine)

- [x] 2026-07-23: `folder` module — list/create/rename/move/delete + breadcrumb, every route gated
  through the Module 2.5 engine, all audit-logged. Depth checked at creation **and on move**
  (against the deepest descendant, not the folder being moved); lowering a limit never orphans
  existing folders; a folder can't move into its own subtree; confidentiality propagates down and
  can't be downgraded; delete refused unless empty (no soft-delete column exists on `folder`).
  Confidential folders **and their descendants** are filtered out of the tree at the query layer.
  `npm run check:folders` — 23 assertions, all passing.
- [x] 2026-07-23: `GET /departments/:id/my-permissions?folderId=` — the caller's resolved
  permission map, re-resolved per folder, so the UI can render controls the role actually has.
- [x] 2026-07-23: **department workspace** (`/w/:departmentId`) — dark rail with department
  switcher, folder tree, breadcrumb, folder table with per-row actions, and permission-driven
  chrome (no upload permission → no upload button, not a disabled one). `"/"` now lands Super
  Admins on the overview and everyone else in their department (Feature Spec §4).
- [x] 2026-07-23: **fixed a real engine bug found by this module** — the confidential named list
  was resolved from the *nearest* confidential ancestor, which broke once folder creation started
  propagating `is_confidential` to children: a member of the outer vault was locked out of
  everything inside it. Both the resolver and the exclusion list now consider every confidential
  folder in the chain. See `each_update.md`.
- [x] 2026-07-25: **`FolderPermission` overrides (FLD-3) — done.** `listFolderPermissions` /
  `setFolderPermission` / `clearFolderPermission` on the folder service, plus routes under
  `/departments/:id/folders/:fid/permissions` gated by `configuration.edit_rules` resolved at the
  **department** level (a folder's own override can't lock the admin out of editing it). An override
  is stored as "all keys true except the restricted ones", so a permission later added to the role
  passes through and is inherited rather than silently withheld. Restrict-only is inherent (the
  engine intersects); overrides are refused on confidential folders (they use a named list instead).
  Frontend `FolderPermissionsDialog` — a "Folder access" button on any non-confidential folder for
  Department Admins: pick a role, untick permissions to restrict here (with dependency cascade),
  "Reset to inherited" clears it. `npm run check:folders` now **31 assertions** (was 23), incl.
  restrict-only, cascade-down-the-subtree, report, clear, and the confidential-folder refusal.
- Backend: `Folder` CRUD (create/rename/move/delete), self-referencing tree, depth validated **at creation time only** against the department's effective limit (own override, else org default) — lowering the limit later must never orphan existing deeper folders (FLD-2).
- Backend: `is_confidential` flag exists on `Folder` already — the *behavior* (named-list access, query exclusion) is Module 9, not this one. Just don't let this module treat it as an ordinary restricted folder.
- Frontend: department view shell — left sidebar (quick views placeholder + folder tree), main panel listing subfolders and files together (files come in Module 5), breadcrumb, create/rename/move/delete UI.
- Frontend: move re-nests and re-resolves permissions from the new parent unless the folder has its own override (FLD-4).

---

## 7. Module 5 — Documents, identity & versioning

**Status:** ✅ Done (2026-07-24) — file-ingesting HTTP endpoints deliberately deferred to Module 6 (see note)
**Requirement IDs:** DOC-1, DOC-2, DOC-3, DOC-4, DOC-5, DOC-6
**Depends on:** Module 4 (folders), Module 2.4 (document types/fields)

- [x] 2026-07-24: `document` module (`backend/src/modules/document/`) + `lib/document-ref.ts`.
  `generateDocumentRef` mints `DEPT-TYPE-YYYY-NNNNN` inside the same `$transaction` as the document
  create (a rolled-back create burns no sequence number); `createDocument`/`addVersion`/
  `restoreVersion`/`editMetadata`/`getDocument`/`lookupByRef`/`listFolderDocuments` in the service.
  Versions never overwrite; restore copies the source version forward reusing its `storage_ref`;
  intervening versions retained. Field-value validation (required, dropdown options, number/date,
  unknown/duplicate fields) and title derivation from the type's title field. Every state change
  audit-logged. `npm run check:documents` — **40 assertions, all passing.** See `each_update.md`.
- Backend: `DocumentRefSequence`-backed ID generator — format `DEPT-TYPE-YYYY-NNNNN`, atomic increment, scoped per org/department/type/year. **Immutable, never reused, shared across all versions** — this is a CLAUDE.md hard rule, and DOC-2's whole acceptance criterion.
- Backend: `Version` creation on upload — **never overwrite**; a new version is a new row. Restore = copy the old version forward as a new current version (also a CLAUDE.md hard rule).
- Backend: `FieldValue` read/write against the document's `DocumentType.FieldDef` set.
- Backend: exact-match ID lookup (DOC-3) — pasting an ID should route straight to the document, not a search-results list.
- Frontend: (mostly folds into Module 6/7 UI — this module is primarily backend plumbing that Upload and Viewer both consume.)
- **Module 5/6 boundary, drawn deliberately:** the operations that need *no file bytes* are HTTP
  endpoints now (`GET /documents/:id`, `GET /documents/lookup?ref=`, `GET /documents?folderId=`,
  `POST /documents/:id/versions/:vid/restore`, `PATCH /documents/:id/metadata`). The two that ingest
  a new file — first upload and upload-a-new-version — are **Module 6**: it stores the file through
  the storage abstraction and then calls this module's `createDocument`/`addVersion` (already built
  and tested with a stand-in `storageRef`). This keeps the document model storage-agnostic.
- **Permission model note:** document-scoped routes resolve permission *inside the service* by the
  document's own folder (identity-based access — the viewer has an ID, not a path), returning
  `document_not_found` rather than `forbidden` when the actor may not view, so a confidential
  document's existence never leaks. The folder-scoped list uses the `requirePermission` preHandler.

---

## 8. Module 6 — Upload & capture

**Status:** ✅ Done (2026-07-24) — backend + frontend; live byte-upload not driven by the automation tool (see note)
**Requirement IDs:** UPL-1 through UPL-7
**Depends on:** Module 3 (storage), Module 5 (document/version model)

- [x] 2026-07-24 (backend): `upload` module + OCR worker. Single multipart upload endpoint
  (`POST /departments/:id/folders/:fid/documents/upload`) — validates format (PDF/PNG/JPEG/DOCX/
  XLSX) and size (120MB, UPL-7), hashes bytes (sha256), stores via the storage abstraction, and
  creates a document in **never-block mode** (saves even when required fields are missing, UPL-5).
  Duplicate-on-upload (UPL-4): a checksum match returns `409 duplicate_detected` with the matching
  documents; the client resolves with `new_version` / `keep_both` / `skip`. New-version-of-existing
  upload endpoint (`POST /documents/:id/versions/upload`). Needs-details queue
  (`GET /departments/:id/documents/needs-details`) derived from missing required-field values — no
  new schema state. OCR pipeline: BullMQ `ocr` queue, a separate worker (`npm run worker`) that
  reads the file through storage, extracts text (Tesseract for images, embedded-text for PDFs,
  none for Office), and writes `ocrText`/`ocrStatus`; every failure degrades to `failed` +
  metadata-only search (UPL-6). Orphan cleanup: a stored object is deleted if the DB write fails.
  A `checksum` column was added to `version` (Data Model §4.5 updated first, then migrated).
  `npm run check:upload` — **17 assertions, all passing** against real R2; the full
  queue→worker→storage→DB OCR chain verified live. Also closed the `MAIL_DISABLED` housekeeping
  item. See `each_update.md`.
- [x] 2026-07-24 (frontend): `UploadPanel` (drag-and-drop + browse, per-type generated metadata
  form, bulk shared-fields bar + per-file title, duplicate-resolution dialog, per-file progress),
  `NeedsDetailsPanel` (complete incomplete uploads), and `MetadataFields` (shared form generator).
  Wired into the workspace: real document listing per folder (folders first, then documents),
  working upload button + whole-panel drag-drop, per-document "New version", a "needs details" pill,
  and copy-ID on the document plate. `lib/documents.ts` carries a multipart client (FormData,
  bypassing the JSON `apiRequest`, with its own refresh-on-401). `tsc`/`eslint`/`vite build` clean.
  **Browser-verified** (real logged-in session, Accounts dept): workspace root, folder view, the
  upload modal, the portal `Select` of document types, and every empty/hint state render correctly.
  The one thing not exercised live: pushing actual file *bytes* — the browser-automation tool only
  uploads files the user has shared with the session, so it rejected a scratchpad test file. The
  byte path itself is covered by the backend `check:upload` (17/17 against real R2) and the live OCR
  chain; what's unverified-in-browser is only the multipart POST wiring, which is typechecked.
- **Bulk upload is client-side orchestration:** each file is one independent call to the single
  endpoint (so one file's missing detail never blocks the batch — UPL-3/UPL-5); the shared-fields
  bar applies common values to each per-file request. No distinct bulk backend endpoint.
- Backend: single upload endpoint — auto-fill department/uploader/date/type-from-folder; generate `document_ref` + first `Version` via Module 5's ID generator; store file via Module 3's storage interface.
- Backend: bulk upload — shared-fields bar applied once across a batch, non-blocking per-file save, "needs details" queue for incomplete items (UPL-5).
- Backend: duplicate detection → offer add-as-new-version / keep-both / skip (UPL-4).
- Backend: OCR pipeline — BullMQ job enqueued per uploaded file, Tesseract worker populates `Version.ocrText` / `ocrStatus`; failure degrades gracefully to metadata-only search rather than blocking (UPL-6).
- Backend: max upload size (margin above 100MB) and OCR page ceiling enforced (UPL-7).
- Frontend: upload button + drag-and-drop, generated-per-document-type form (fields come from Module 2.4's `FieldDef` set — this is where that investment pays off), bulk-upload shared-fields bar UI, "needs details" queue view.
- Formats: PDF, JPEG/PNG, DOCX, XLSX only — reject others with a clear message, don't fail silently.

---

## 9. Module 7 — Search & retrieval

**Status:** ✅ Done (2026-07-24) — backend 21 checks green; frontend built & compile-clean (browser check pending a member login)
**Requirement IDs:** SRCH-1 through SRCH-5
**Depends on:** Module 5/6 (documents + OCR text must exist to index)

- [x] 2026-07-24: `search_vector tsvector` column on `document` (GIN-indexed; Data Model §4.3 updated
  first, then migrated), maintained by `refreshDocumentSearchVector` — weighted A=ref/title,
  B=field values + filename, C=OCR text — called from create / edit-metadata / new-version / restore
  and from the OCR worker. `search` module: `POST /departments/:id/search` (gated by `search.search`)
  with a prefix tsquery (search-as-you-type), per-field filters (contains / exact / dropdown-in /
  date-range / number-range) as stacked EXISTS conditions, document-type scope, quick views (recent
  + uploaded-by-me real; shared/trash honest empties), most-recent-first default / relevance when
  querying, and the confidential-folder exclusion at the query layer (SRCH-5). `npm run check:search`
  — **21 assertions, all passing** (incl. OCR-text hits, every filter type, and confidential/Super-
  Admin exclusion). Existing documents backfilled. Frontend: the workspace search bar is live
  (debounced), a schema-generated `SearchFilterPanel`, clickable Recent / Uploaded-by-me quick views
  in the rail, and a results view (ID+copy, title, type, folder link). `tsc`/`eslint`/`vite build`
  clean. **Browser check pending:** a Super Admin isn't a department member (no `search.search`), so
  verifying live needs the `ajuzzz1234` member login. See `each_update.md`.
- Backend: Postgres `tsvector` index over filename, `FieldValue`, and `Version.ocrText` (Tech Stack doc — no external search engine at this scale). Filter-panel query generation driven by each `FieldDef.field_type` (text/ID exact, dropdown multi-select, date range, number range, person picker) — same "define once" field metadata Module 2.4 built.
- Backend: quick views — Recent, Uploaded by me, Shared with me (stub until Module 8 exists), Trash (stub until Module 10 exists).
- Backend: **confidential-folder documents must never appear in results for non-members** — enforce at the query layer here, do not rely on later UI filtering (SRCH-5, and a CLAUDE.md hard rule). This can be built as a query-layer guard now even before Module 9's full confidential-folder feature ships, since it's cheaper to bake in from the start than retrofit.
- Frontend: global search bar (search-as-you-type), filter panel, quick-view tabs, default most-recent-first sort.

---

## 10. Module 8 — Document viewer

**Status:** ✅ Done (2026-07-24) — backend 12 checks green; frontend built & compile-clean (browser check pending a member login)
**Requirement IDs:** VUE-1 through VUE-5
**Depends on:** Module 5 (documents/versions), Module 2.5 (permission-driven toolbar)

- [x] 2026-07-24: **Backend** — `getDocument` now returns the caller's resolved permissions + a
  per-document activity feed (a filtered `AuditEvent` slice) and logs a `view`; `GET /documents/:id/
  activity` (refresh without re-logging a view); `GET /documents/:id/file?versionId=&download=1`
  streams a version's bytes for preview (`documents.preview`) or download (`documents.download`),
  bytes through the storage abstraction, download audit-logged. **Frontend** — `DocumentViewerPage`
  (route `/documents/:id`): two-panel layout, preview (PDF in an iframe / images inline, fetched as
  an authed blob → object URL since an `<img>`/`<iframe>` src can't carry the Bearer token), the ID
  monospaced+copyable as the details header, metadata read-only or editable-in-place under
  `edit_metadata`, version history with restore + upload-new-version, and the activity feed. Toolbar
  is fully permission-driven (download/edit/new-version appear only when granted — VUE-5). Folder
  rows and search results now open the viewer. `npm run check:viewer` — **12 assertions green**
  (real R2 preview/download, permission gating, view/download logging). `tsc`/`eslint`/`vite build`
  clean. **Browser check pending** a department-member login (Super-Admin-only session can't view
  documents). See `each_update.md`.
- Backend: document detail endpoint — metadata, version list, per-document activity feed (a filtered slice of `AuditEvent`, not a separate table).
- Frontend: in-browser preview for supported formats, document ID shown monospaced/copyable, metadata panel (editable in place under permission, read-only otherwise), version history panel with restore + "upload new version" actions, activity feed.
- Frontend: every toolbar action (download, share, edit) appears only if the Module 2.5 engine grants it — a Viewer role should see a genuinely read-only screen, not a disabled-button screen.

---

## 11. Module 9 — Sharing

**Status:** ✅ Done (2026-07-25) — backend 34 checks green (`npm run check:sharing`); frontend built & compile-clean (browser check pending a member login)
**Requirement IDs:** SHR-1 through SHR-6
**Depends on:** Module 8 (viewer is where sharing is triggered from), Module 2.5 (permission gating)

- [x] 2026-07-25: `sharing` module (`backend/src/modules/sharing/`) + `lib/share-access.ts` (the
  recipient-by-reference resolver, consulted by `document.service` as a fallback after the role
  chain). Internal user/department shares, cross-department two-sided consent (SHR-3, lands
  `pending`), external secure links (SHR-4: mandatory expiry, hashed `link_token`, logged access via
  `link_access` attributed to the link creator, revocable), doubly gated by the external-share
  permission **and** the department's default-sharing rule (SHR-5). Confidential documents can never
  leave by link — enforced by the engine forcing `sharing.external_share`/`create_link` off inside a
  confidential folder, so no separate check is needed. Revoke/downgrade/extend (SHR-6) without
  recreating. Every action audit-logged. `npm run check:sharing` — **34 assertions, all passing**,
  incl. share-by-reference access, revoke-is-instant, confidential block, a share that cannot pierce
  confidentiality, expiry, and opened-count. See `each_update.md`.
- [x] 2026-07-25 (frontend): `ShareDialog` wired into the viewer toolbar — internal and external
  zones separated by a divider, the external zone **absent** where not permitted (never disabled).
  `SharesPage` (`/shares`) with Shared-with-me / Shared-by-me tabs (source department, sharer,
  permission badge, opened count, expiry countdown, revoke). Public external-link page
  (`ExternalLinkPage`, route `/l/:token`) for account-less recipients — preview + permission-gated
  download. Workspace rail's Shared views and the org sidebar now link to `/shares`.
- **Flagged decision:** the `Share` schema models `targetType = user | department | external_link`
  only — there is **no role target**, though the PRD mentions sharing to a role. Built to the
  schema (user/department/external) and deferred role-sharing; it becomes a new `targetType` if a
  role FK is ever added, not a rewrite. Also flagged: the docs require the receiving side to be able
  to *refuse* a cross-department share (SHR-3) but never name the permission that confers it —
  mapped to `sharing.cross_department_share` on the receiving department.
- **Not verified in a browser** (same Super-Admin-only-session limitation as Modules 6/7/8): a Super
  Admin isn't a department member, so exercising the share dialog live needs the `ajuzzz1234` member
  login. Backend is green end-to-end against real R2 (link file serving included).

---

## 12. Module 10 — Confidential folders

**Status:** ✅ Done (2026-07-25) — backend 29 checks green (`npm run check:confidential`); frontend built & compile-clean (browser check pending a member login)
**Requirement IDs:** CNF-1 through CNF-5
**Depends on:** Module 4 (folders), Module 2.5 (engine must special-case this), Module 7 (search exclusion already primed)

- [x] 2026-07-25: **Creation + named list (CNF-1)** — `folder.createFolder` gained an `isConfidential`
  + `memberUserIds` path; a folder that *begins* a confidential branch seeds the creator as owner
  (`ConfidentialMember.isOwner`, un-removable) plus any named members. Inherited-confidential
  subfolders carry no member rows of their own — they read the list from the confidential ancestor.
  New `confidential` module: `listMembers`/`addMember`/`removeMember`, all vault-member-gated (roles
  grant nothing; Super Admin refused with `folder_not_found`, never a leak). Management from any
  folder in the vault resolves to the branch root.
- [x] 2026-07-25: **Invisibility (CNF-2)** already enforced at the query layer by the engine's
  `confidentialFolderIdsToExclude` — verified: folder tree, search, and needs-details all filter,
  and org-dashboard counts still *include* confidential folders (counts, never contents). Nothing
  new needed beyond confirming coverage.
- [x] 2026-07-25: **Super Admin excluded + external links blocked + propagation (CNF-3)** — all in
  the engine already (Module 2.5/4); the check script asserts them against the new creation path.
- [x] 2026-07-25: **Dual-control recovery (CNF-4)** — new `confidential_recovery` table (Data Model
  §7.2 updated first, migration `20260725..._confidential_recovery`). An orphaned vault (0 members)
  is discoverable only to a Super Admin / Department Admin (a deliberate, narrow exception to
  invisibility, since recovery is otherwise impossible). `initiateRecovery` records the initiator's
  own approval; `approveRecovery` requires the *other* authority — completion needs both a Super
  Admin and a Department Admin, from two distinct people, and grants the nominee owner access. Every
  step audit-logged as a confidential event.
- [x] 2026-07-25: **Frontend** — a "Make this a confidential folder" toggle + named-member picker in
  the folder-create form (suppressed under a confidential parent, which is auto-confidential); a
  "Manage access" dialog on any confidential folder (add/remove members, owner protected); and a
  "Recovery" dialog for Super Admins / Department Admins listing orphaned vaults and pending
  requests with the two-approver flow. `PeoplePicker` reuses the org-users endpoint.
- [x] 2026-07-25: `npm run check:confidential` — **29 assertions, all passing** (named-list access,
  inheritance disabled, owner un-removable, Super Admin excluded, propagation, tree invisibility,
  external-link block, member add/remove, and the full dual-control recovery: orphan → initiate →
  single-authority-can't-complete → both-approve → nominee becomes owner). No regressions in
  `check:folders` (23) or `check:permissions` (30).
- **Note:** CNF-5 ("confidential access logged, visible only to the confidential-audit role") — the
  *logging* half is done (opens/downloads/member changes write confidential audit events); the
  *viewer* half (filtering them to `view_confidential_audit` holders) lands with Module 12.
- **Not browser-verified** (same Super-Admin-only-session limit): needs the `ajuzzz1234` member
  login to click through creation, the manage dialog, and recovery.

---

## 13. Module 11 — Trash & recovery

**Status:** ✅ Done (2026-07-25) — backend 19 checks green (`npm run check:trash`); frontend built & compile-clean (browser check pending a member login)
**Requirement IDs:** TRSH-1 through TRSH-4
**Depends on:** Module 5 (documents must exist to delete)

- [x] 2026-07-25: **Soft-delete + trash view + restore (TRSH-1/2).** `deleteDocument` sets
  `status=in_trash` + `deletedAt` + `deletedByUserId` (new column, Data Model §4.1 updated first, then
  migration). Trashed docs already fall out of search/recent (status filter) and the folder listing.
  `listTrash` returns each item with who deleted it, its origin folder, and a 30-day auto-remove
  countdown (confidential folders excluded at the query layer). `restoreDocument` returns it to its
  origin folder with ID/metadata/version history intact. Delete gated by `documents.delete`, trash
  view + restore by `documents.restore`.
- [x] 2026-07-25: **Purge + empty trash (TRSH-3).** `purgeDocument` / `emptyTrash` are Department-Admin
  only (checked in the service via `hasDepartmentAdminCapability`), the only place data truly
  disappears — they delete the version files through the storage abstraction plus the version /
  field-value / share / document rows, and revert storage usage. **The append-only audit trail
  survives**: `audit_event.document_id` is now `ON DELETE SET NULL`, so the delete/purge events keep
  their action, actor, timestamp and the doc's ref in `target_description` while the row is gone.
- [x] 2026-07-25: **Retention-lock enforcement path (TRSH-4).** `isRetentionLocked()` guards purge and
  restore; the lock *source* is R2 (retention rules per type), so it returns false in R1 and the guard
  is a no-op — but every call site already honours it, so R2 just gives the predicate a body. No R2
  automation built, per CLAUDE.md.
- [x] 2026-07-25: **Frontend.** A Delete button in the viewer toolbar and per-row in the folder
  listing (`documents.delete`); a **Trash** quick view in the workspace (same main-panel list as the
  others) showing deleter / origin / countdown, a Restore action, and — for Department Admins — a
  hard-confirmed "Empty trash" plus per-item "Delete forever". Retention-locked items show a Locked
  badge and disable their actions.
- [x] 2026-07-25: `npm run check:trash` — **19 assertions, all passing** against real storage (delete
  → leaves listings → trash shows deleter+origin+countdown → restore to origin → purge is Dept-Admin
  only and deletes files+rows → audit survives with a nulled link → empty-trash). No regressions in
  `check:documents` (40) or `check:viewer` (12).
- **Not browser-verified** — needs a member/Dept-Admin (`ajuzzz1234`) session to click through
  delete / restore / empty-trash.

---

## 14. Module 12 — Audit log viewer & export

**Status:** ✅ Done (2026-07-25) — backend 15 checks green (`npm run check:audit`); frontend built & compile-clean (browser check pending a member login)
**Requirement IDs:** AUD-1 through AUD-5
**Depends on:** every module above, since it surfaces their events

- [x] 2026-07-25: **AUD-1 audit-of-the-audit-trail** — a grep of every `logAuditEvent` call confirms
  every significant action logs: view, upload, download, edit, delete, restore, share, link_access,
  config_change, role_change, member_change, permission_change. Login/register are deliberately
  *not* logged (global-account actions with no org FK, per the Data Model §8 scope decision — and
  AUD-1's own list doesn't include them). Nothing to backfill.
- [x] 2026-07-25: **Backend `audit` module** — `GET /departments/:id/audit` with four combinable
  filters (actor, action, document free-text on the description, date range), gated by `audit.view_audit`.
  **Confidential segregation (AUD-5):** events with `is_confidential` are excluded from the query
  entirely unless the caller holds `audit.view_confidential_audit` — a Super Admin, lacking that key,
  never even sees a confidential doc was touched. **Export (AUD-4):** `GET .../audit/export` returns
  RFC-4180 CSV, gated by the *separate* `audit.export_audit` at the route — a View-audit-only Auditor
  is refused before any record is read.
- [x] 2026-07-25: **AUD-3 append-only confirmed** — a codebase grep shows no `auditEvent.update` /
  `.delete` anywhere in `src/` (only test-script cleanup); the `lib/audit.ts` helper exposes a create
  and nothing else. (The Module 11 `ON DELETE SET NULL` on `document_id` is referential integrity on
  purge, not an app edit path — the event's action/actor/time/description are untouched.)
- [x] 2026-07-25: **Frontend** `AuditPage` (`/w/:departmentId/audit`) — filter bar (user / action /
  document / from / to), a colour-weighted action table (delete=danger, permission/role/member=
  warning, share/link=info), a "includes confidential events" badge when the caller may see them, and
  a CSV **Export** button shown only with `export_audit`. Reached from an "Audit log" button in the
  workspace header for holders of `view_audit`.
- [x] 2026-07-25: `npm run check:audit` — **15 assertions, all passing** (confidential hidden without
  the key / shown with it, each filter narrows correctly, export gated, view-only auditor refused
  export, no-view-audit role refused entirely).
- **Not browser-verified** — needs an Auditor / Dept-Admin (`ajuzzz1234`) session to click through.

---

## 15. Module 13 — Non-functional hardening

**Status:** ✅ Done (2026-07-25) — 5 real defects found and fixed; all PRD targets met with headroom
**Depends on:** all functional modules substantially complete

- [x] 2026-07-25: **Static tenant-isolation audit.** All 274 Prisma call sites in `backend/src`
  classified via a scanner (extracts each call's balanced argument text, flags anything without
  `organizationId` on a non-global model); 108 flagged for manual review, **every one legitimately
  scoped** — transitively (update-by-id after an org-scoped fetch) or by paired filter. No unscoped
  query exists. Traced `actor.organizationId` to its source: a JWT claim minted only after
  `assertUserBelongsToOrganization`, so the value every query trusts is sound. Search's raw SQL is
  fully `Prisma.sql`-parameterised.
- [x] 2026-07-25: **`npm run check:tenant-isolation` — 69 assertions green.** Two complete
  organizations built from scratch, then every service called with org B's actor and org A's ids
  (documents, folders, departments, roles, members, doc types, search, sharing, audit, confidential
  vaults, storage refs) plus referential sanity checks. Includes "org B's Super Admin resolves nothing
  in org A" — ownership is not global.
- [x] 2026-07-25: **`npm run check:access-matrix` — 77 assertions green.** 6 principals × 4 locations
  (ordinary folder, override-restricted folder, confidential vault, second department), each checked
  for read access and per-action capability. This is the PRD §4 "verified by test matrix" goal.
- [x] 2026-07-25: **Five defects found and fixed** — see `each_update.md` for the full write-up:
  **(a)** a Department Admin could purge confidential documents they cannot see (`purgeDocument` had
  no view/confidential check; `emptyTrash` had no confidential exclusion, so it destroyed more than it
  displayed); **(b)** a folder override hid a document on open but **not in search** — IDs, titles and
  types leaked in results, fixed with a new `unviewableFolderIdsToExclude()` in the engine, now used by
  search, needs-details and trash; **(c)** `folderPath` threw a raw Prisma `P2025` (a 500) across the
  tenant boundary instead of a 404; **(d)** two authority checks (`listPendingForDepartment`,
  `requireRecoveryAuthority`) accepted a foreign `departmentId` — no leak, but the wrong shape;
  **(e)** **image OCR was completely non-functional** — `Tesseract.recognize is not a function`, a
  CJS/ESM interop bug in the worker, failing *silently* because UPL-6's graceful degradation recorded
  it as `ocrStatus = failed`. PDFs were unaffected, which is why Module 6's sign-off missed it.
- [x] 2026-07-25: **`npm run check:performance` — every PRD target met with headroom.** Search
  **73 ms** against a 2 s budget (500-document corpus, 9 query shapes, worst of 3 runs); 20-file bulk
  upload **28.6 s** against 2 min through real R2; OCR searchable end-to-end **2.0 s** against 5 min.
  The "single upload ≤ 3 clicks" target is a UI property, left to the browser pass. Actuals are printed
  with % of budget, so a target met with no headroom can't hide behind a pass.
- [x] 2026-07-25: **Encryption confirmed.** Passwords argon2id; every token (refresh, verification,
  reset, invitation, external link) SHA-256 hashed at rest; storage credentials AES-256-GCM, decrypted
  only inside the storage service and never returned to the client; refresh cookie httpOnly/lax/secure
  in production. TLS in transit and DB-at-rest are Module 14's reverse proxy + Postgres config.
- **Documented layering invariant:** folder mutations and search are gated in the **route preHandler**
  (`app.requirePermission`), not inside the service — deliberate, and `check:folders` depends on it
  (it builds its fixture as a Super Admin, who holds no `folders.*` key). Document-scoped operations
  are the opposite by design: identity-based, so they resolve permission *inside* the service. The
  matrix asserts each at the layer where its gate actually lives.
- **Flagged, deliberately not changed:** the folder *tree* still hides only confidential folders. An
  override-restricted folder stays visible and navigable — the restriction is on its contents, and
  making the folder itself vanish would be inventing policy the docs don't state.

---

## 16. Module 14 — Deployment & operations

**Status:** ⬜ Not started
**Depends on:** functional modules ready to deploy

- Docker Compose for backend + Postgres + Redis + reverse proxy (per Tech Stack doc §3.9), Caddy/Nginx + Let's Encrypt for TLS, static frontend served by the same proxy.
- Monitoring: Uptime Kuma, Sentry free tier, container log rotation.
- Backups: scheduled `pg_dump` to object storage.
- CI/CD: GitHub Actions — build, test, deploy.

---

## 17. Explicitly NOT to build yet (Release 2 — reference only)

Per `docs/DMS_Scope_and_MVP_Definition.md` §4 and CLAUDE.md's "Current build phase." Do not implement these even if a module above feels like it's "almost" one of these — flag it and move on:

1. Audit export *enhancements* beyond the R1 basic export in Module 12 (the R1 export itself is in scope).
2. Retention & lifecycle automation (periods, auto-archive, retention locks, expiry reminders) — blocked on compliance detail (Scope doc §6.2) that hasn't been supplied yet.
3. Notifications (in-app/email).
4. Workflow & approvals (document states, routing, approval queue) — *unless* a stakeholder identifies a launch-critical approval process (Accounts invoice approval is the noted candidate); otherwise leave `document.workflow_state` unused but present.
5. Auto-extraction (OCR-driven field pre-fill with confidence tiers).
6. Reporting (org/department dashboards beyond Module 1.6's thin counts).
7. Admin share-oversight view; standing cross-department folder shares.
8. Saved searches; global cross-department search.
9. Save-configured-department-as-template (DEP-5).
10. Additional storage backends (S3, per-department storage); 2FA; SSO.

---

## 18. Quick status board

| # | Module | Status |
|---|---|---|
| 0 | Foundations (scaffold, schema, auth) | ✅ Done |
| 1 | Organization completion (storage setup, user directory, onboarding, dashboard) | ✅ Done — including 1.3's invite-by-email, completed 2026-07-23 |
| 2 | Department creation (wizard, templates, schema builder, vocabulary, rules) | ✅ Done (2.6's auto-tagging half deferred to Module 4/6 — no tag column, no folders yet) |
| 2.5 | Permission engine | ✅ Done — 30 checks green (`npm run check:permissions`); Super Admin scope narrowed 2026-07-23, deviates from Feature Spec §2A.1 |
| 3 | Storage abstraction layer (NAS + R2 drivers) | ✅ Done — confirmed complete + runtime `getActiveStorageDriver` added (2026-07-24) |
| 4 | Folders | ✅ Done — CRUD + workspace + folder permission overrides (31 checks green) |
| 5 | Documents, identity & versioning | ✅ Done — 40 checks green (`npm run check:documents`); file-ingesting HTTP endpoints are Module 6 |
| 6 | Upload & capture (incl. OCR) | ✅ Done — backend 17 checks green + live OCR chain; frontend built & browser-verified (byte-upload not driven by the tool) |
| 7 | Search & retrieval | ✅ Done — backend 21 checks green (`npm run check:search`); frontend built & compile-clean |
| 8 | Document viewer | ✅ Done — backend 12 checks green (`npm run check:viewer`); frontend built & compile-clean |
| 9 | Sharing | ✅ Done — backend 34 checks green (`npm run check:sharing`); frontend built & compile-clean |
| 10 | Confidential folders | ✅ Done — backend 29 checks green (`npm run check:confidential`); frontend built & compile-clean |
| 11 | Trash & recovery | ✅ Done — backend 19 checks green (`npm run check:trash`); frontend built & compile-clean |
| 12 | Audit log viewer & export | ✅ Done — backend 15 checks green (`npm run check:audit`); frontend built & compile-clean |
| 13 | Non-functional hardening | ✅ Done — tenant-isolation 69 + access-matrix 77 checks green; performance targets met with headroom; 5 defects fixed |
| 14 | Deployment & operations | ⬜ |

**Suite totals (2026-07-25, all green):** `permissions 30 · folders 31 · documents 40 · search 24 ·
viewer 12 · sharing 39 · confidential 29 · trash 19 · audit 15 · tenant-isolation 69 · access-matrix 77
· performance 11 passed / 1 skipped` — **396 assertions across twelve suites.**

**Next up:** **Module 14 (Deployment & operations)** — Docker Compose + reverse proxy/TLS, backups
(`pg_dump`), monitoring, CI/CD — plus the **browser-verification pass** as a member (`ajuzzz1234`),
which is now the only functional debt left and should be done first since it closes the list below.

**Small follow-ups worth doing, all needing a department-member (`ajuzzz1234`) browser session that
the Super-Admin-only login can't provide:** a visual pass on **Module 7 search**, the **Module 8
viewer** (preview/download/edit/version/activity), the **Module 9 share dialog + shared views + the
external-link page**, the **Module 10 confidential create / manage / recovery**, the **Module 4
folder-access override dialog**, the **Module 11 delete / trash / restore / empty-trash**, the
**Module 12 audit viewer + export**, plus the outstanding **Module 6 upload byte-path** check. All
are green at the backend and compile-clean in the UI.

**Housekeeping flagged 2026-07-23:** the invitation tests sent real mail through Brevo to
`@example.test` addresses. Add a mail-disabled switch for test runs before exercising that path
again — repeated bounces hurt sender reputation.
