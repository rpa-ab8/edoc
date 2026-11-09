# Product Requirements Document — Edoc

**Release:** Release 1 (MVP)
**Version:** 1.0 — Draft for review, amended by v1.2 (retention, Legal Hold, standard filters — §8.14)
**Status:** Ready for development planning
**Audience:** Engineering, product, stakeholders

> Companion documents: *Feature & Flow Specification* · *Scope & MVP Definition* · *Data Model*. Where this PRD and those documents differ on Release 1 scope, the *Scope & MVP Definition* governs.

---

## 1. Document control

### 1.1 Related documents

| Document | Purpose |
|---|---|
| Feature & Flow Specification | Functional design of every screen and behaviour |
| Scope & MVP Definition | Definitive Release 1 vs Release 2 boundary; confirmed decisions |
| Data Model | Entities, fields, relationships, authentication tables |
| This PRD | Assembles the above into a development-ready requirement set with personas, journeys and acceptance criteria |

### 1.2 Confirmed foundation decisions

All foundation and design decisions are closed. The compliance detail required for Release 2 (document type → retention period) is the only outstanding input and does not block Release 1.

| Area | Decision |
|---|---|
| Deployment | SaaS; storage backend chosen per organization at setup (NAS or Cloudflare R2 in R1), behind a storage abstraction layer |
| Tenancy | Multi-organization architecture, operated with one organization at launch. Organizations are self-created; the creator becomes Super Admin |
| Identity | Global user account (one per email), holding memberships across organizations |
| Authentication | JWT access tokens with server-side (revocable) refresh tokens; self-hosted, no third-party provider |
| Roles | One role per user per department; a user may hold roles in many departments |
| Retention | **Amended v1.2:** an optional per-department auto-delete period and Legal Hold ship in R1 (§8.14). Retention locks, per-document-type periods, auto-archive and expiry reminders stay Release 2 |
| Migration | No bulk import in R1; documents uploaded manually |
| Scale | Up to 250 users, ~50 concurrent, files typically under 100 MB |

---

## 2. Executive summary

Edoc is a universal, multi-sector platform for storing, organising, finding and controlling access to documents. A single codebase serves healthcare, education, accounts, HR and legal operations — sector differences are handled through configuration rather than custom development, so onboarding a new department or sector is an administrative task, not an engineering project.

The organisation currently stores documents manually and across scattered systems, causing slow retrieval, no version control, duplication, weak access control and compliance difficulty. Edoc centralises documents under a secure, permissioned, audited system with search that reaches inside document content.

Release 1 delivers the complete daily loop — configure a department, upload (single or bulk), find, preview, share internally or by external link, with role-based permissions, versioning, trash recovery and a full audit trail. Retention automation, workflow approvals and reporting follow in Release 2, built on data captured from day one.

This document defines the personas, journeys, functional and non-functional requirements, permission model and release plan for Release 1, with acceptance criteria suitable for development and QA.

---

## 3. Product overview

### 3.1 The problem

Across healthcare, education and corporate departments, documents are stored manually or scattered across multiple systems, resulting in delayed retrieval, no version control, data duplication and loss, limited security and access control, and compliance challenges. A unified system is required to centralise storage, retrieval, tracking and security.

### 3.2 The solution — a universal, configurable system

The system is split into two layers. A **universal core engine** — storage, search, versioning, the permissions engine, audit logging, OCR, encryption and sharing — is built once and never changes per sector. A **configuration layer** holds everything sector-specific as data: document types, metadata fields, roles, retention rules and the on-screen vocabulary.

Consequently the three sectors of the original brief become three example configurations rather than three separate builds, and any new sector is a setup task performed by an administrator.

### 3.3 Product principles

- **Configuration, not code** — anything that differs by sector is data an administrator can set.
- **Templates over blank canvases** — power is available but never the starting point.
- **Define once, use everywhere** — one field definition drives the upload form, the filter control and the search index.
- **Rich metadata, light typing** — the system captures and pre-fills; the user confirms.
- **Share by reference** — one copy always, so version history and revocation stay intact.
- **Isolated by default, opened deliberately** — departments are walled; every crossing is explicit, permissioned, logged and revocable.
- **Never block the user** — incomplete uploads save; missing details are finished later.

---

## 4. Goals and success metrics

Measurable definitions of the project's stated goals, validated at user-acceptance testing.

| Goal | Success criterion |
|---|---|
| Easy retrieval | A known document is found in under 10 seconds, with search response under 2 seconds |
| Minimal clicks — upload | A single document uploads in 3 clicks or fewer from the department view |
| Minimal clicks — bulk | 20 documents of one type upload in under 2 minutes |
| Content searchability | Scanned documents are full-text searchable within 5 minutes of upload |
| Access control | No user can view any document outside their permitted departments and folders — verified by test matrix |
| Recoverability | Any deleted document is recoverable within the trash retention window |
| Adoption | Configured departments operate without falling back to shared drives or physical files |

---

## 5. Personas

Five roles interact with Release 1. Permissions are enforced per department; the same person may hold different roles in different departments.

| Persona | Scope | Primary needs |
|---|---|---|
| Super Admin | Whole organization | Create the organization, configure storage, create departments, manage the user directory, oversee at a glance |
| Department Admin | One department | Configure document types, fields, folders, roles and rules; add members; manage the department day to day |
| Staff | One or more departments | Upload quickly, find documents fast, preview, share with colleagues |
| Viewer | One or more departments | Read and preview documents without editing or deleting |
| Auditor | One or more departments | Inspect the audit trail for compliance; cannot edit documents |

Above these sits the document's own **confidential-folder membership** — an explicit named list independent of role — for the organisation's most sensitive material.

---

## 6. User journeys

### 6.1 Super Admin — from nothing to a working organization

- Registers an account (name, work email, password) and creates the organization, supplying an invite code; becomes its Super Admin.
- Verifies their email, then is guided into onboarding.
- Configures storage — chooses NAS or Cloudflare R2, enters connection details, and runs a test connection that must pass before continuing.
- Creates the first department from a template (Healthcare, Education, Accounts, HR or Legal), which pre-fills document types, fields, vocabulary and rules.
- Invites the first users by email, each assigned to a department and a role; lands on the organization dashboard.

### 6.2 Department Admin — configuring a department

- Reviews the template's document types and adjusts fields (label, type, required, filterable, title field) in the schema builder.
- Sets the department vocabulary so the interface reads in the sector's language.
- Reviews the role matrix, copies and renames roles as needed, and ticks permissions; adds members from the organization directory.
- Sets department rules — auto-tagging and default sharing scope (retention automation is Release 2).
- Creates the folder structure, including any confidential folders with named-member access.

### 6.3 Staff — the daily loop

- Logs in and lands directly in their department's documents.
- Uploads a document by drag-and-drop or bulk; system fields auto-fill and OCR runs in the background; saves in a few clicks.
- Finds a document via the search bar (by name, tag, ID or text inside the file) or the filter panel.
- Opens it in the viewer to preview, check metadata and version history, or upload a new version.
- Shares it with a colleague or another department by reference, or creates an external link where permitted.

### 6.4 Auditor — compliance inspection

- Opens the audit log viewer for a department.
- Filters by user, action, document or date range to answer a compliance question — for example, who accessed a category of records last month.
- Reviews immutable records; exports them where granted the separate export permission. Confidential-folder access is visible only with the dedicated confidential-audit permission.

---

## 7. Scope

### 7.1 In scope — Release 1

| Area | Included |
|---|---|
| Identity & auth | Global accounts, JWT + refresh, email verification, password reset, gated signup, organization creation, login with organization picker |
| Organization | Super Admin, user directory, department assignment, organization settings, storage setup with test-connection, thin dashboard |
| Department creation | Five-step wizard; five shipped templates; schema builder; vocabulary; roles matrix; auto-tag & default-sharing rules |
| Documents & folders | Nested folders (both files and subfolders), permission inheritance with overrides, unique document ID, version history, trash & recovery |
| Upload | Single, drag-and-drop and bulk; auto-fill; duplicate-as-new-version; non-blocking save; OCR; format support (PDF, JPEG/PNG, DOCX, XLSX, Markdown, plain text) |
| Search | Global search across name, metadata and OCR text; document-ID exact-match; schema-driven filters; quick views |
| Viewing | In-browser preview, metadata panel, version history and restore, per-document activity, permission-gated download |
| Sharing | Internal by-reference sharing, cross-department sharing with consent, external secure links (mandatory expiry), Shared-with-me / Shared-by-me with revoke |
| Permissions | Three-level model, per-department custom roles, full matrix, dependency enforcement, effective-permission resolution, confidential folders |
| Audit | Logging of all significant events, filterable viewer, export, immutable records, confidential-audit segregation |

### 7.2 Out of scope (Release 1)

- Integration with EMR, HRMS or finance systems (deferred; requires named systems and API assessment).
- Native mobile applications (responsive web only).
- In-browser or collaborative document editing, and e-signature.
- Bulk data migration / import (documents uploaded manually).
- AI classification, summarisation or semantic search.
- Multi-organization features beyond self-creation (billing, organization switching UI polish) — architecture supports them, they are not surfaced.
- Two-factor authentication and SSO.

### 7.3 Release 2 roadmap

Ordered by expected priority. Each builds on Release 1 without changing it.

| # | Release 2 item |
|---|---|
| 1 | Audit export enhancements (viewer and basic export are in R1) |
| 2 | Retention & lifecycle automation — per-document-type periods, auto-archive, retention locks, expiry reminders (needs compliance detail). The per-department auto-delete period and Legal Hold moved into R1 in v1.2 (§8.14) |
| 3 | Notifications — in-app and email |
| 4 | Workflow & approvals — states, routing, approval queue |
| 5 | Auto-extraction — OCR-driven field pre-fill with confidence tiers |
| 6 | Reporting — organization and department dashboards |
| 7 | Admin share oversight; standing cross-department folder shares |
| 8 | Saved searches; global cross-department search |
| 9 | Additional storage backends (S3), per-department storage; save-as-template |
| 10 | Two-factor authentication; SSO |

---

## 8. Functional requirements

Requirements are grouped by module. Each carries an identifier, a statement of what the system must do, and acceptance criteria for verification. Requirement IDs are stable references for traceability and test cases.

### 8.1 Authentication & identity

| ID | Requirement | Acceptance criteria |
|---|---|---|
| AUTH-1 | A person can register a global account with name, work email and password. | Account created; a verification email is sent; the same email cannot create a second account. |
| AUTH-2 | Email verification is required before an organization can be used. | Unverified users are blocked from entering the organization; verifying sets the account verified and unblocks access. |
| AUTH-3 | Organization creation is gated by a server-side signup mode (open / invite_code / disabled), running as invite_code at launch. | With invite_code, a valid code is required and validated server-side; an invalid or used code returns a specific field error. |
| AUTH-4 | Authentication issues a short-lived JWT access token and a server-side refresh token. | Access token expires quickly; refresh rotates on use; a revoked refresh token cannot renew a session. |
| AUTH-5 | A user can reset a forgotten password and sign out of all sessions. | Reset link is single-use and time-limited; consuming it revokes active refresh tokens; disabling an account revokes all its tokens. |
| AUTH-6 | Login resolves the organization after authentication. | A single-membership user enters directly; a multi-membership user is shown an organization picker and can switch in-app. |
| AUTH-7 | Repeated failed logins are rate-limited. | After a threshold of failures the account/IP is temporarily locked; successful login resets the counter. |

### 8.2 Organization & Super Admin

| ID | Requirement | Acceptance criteria |
|---|---|---|
| ORG-1 | Registration creates the organization and makes the creator its Super Admin. | Organization exists with the creator holding organization-wide control; Super Admin is scoped to this organization only. |
| ORG-2 | Super Admin manages the user directory: create, invite, disable, reset, remove. | Inviting an existing global email adds a membership rather than a new account; disabling blocks access without deleting the account. |
| ORG-3 | Super Admin assigns users to departments with a role. | The user → department → role assignment is created; the same user can hold different roles in different departments. |
| ORG-4 | The organization dashboard shows counts and storage, never document contents. | Dashboard shows department, user, document and storage figures; no organization-wide document list exists; confidential folders contribute to totals without exposing names. |
| ORG-5 | Super Admin configures organization settings including the default subfolder depth. | Settings persist and apply organization-wide; a department may override the depth where permitted. |

### 8.3 Storage setup

| ID | Requirement | Acceptance criteria |
|---|---|---|
| STO-1 | During setup the organization chooses a storage backend (NAS or Cloudflare R2) and supplies connection details. | The connection form adapts to the chosen backend; credentials are encrypted at rest and never returned to the client. |
| STO-2 | A test connection performs a write → read → delete round trip before setup can complete. | All four steps (reach, write, read-back, delete) must pass; failure reports a specific, mapped message and blocks completion. |
| STO-3 | The application addresses storage only through an abstraction layer. | Each stored file holds an opaque storage reference, not a path; adding a backend later requires no change to document handling. |
| STO-4 | A failed live upload surfaces a clear storage-error state. | Users see an actionable error rather than a silent failure; the organization dashboard reflects storage status. |

### 8.4 Department creation

| ID | Requirement | Acceptance criteria |
|---|---|---|
| DEP-1 | A department is created through a five-step wizard, starting from a template or blank. | Choosing a template pre-fills document types, fields, vocabulary, roles and rules; all remain editable. |
| DEP-2 | The schema builder defines document types and their fields (label, type, required, filterable, order, title field). | Each type has an independent field set; exactly one field per type is the title; field type determines both upload control and filter control. |
| DEP-3 | Department vocabulary customises on-screen terms. | Buttons, headings and placeholders reflect the configured terms (e.g. 'Add patient document'); a live preview updates as terms change. |
| DEP-4 | A department carries an editable ID prefix used in document IDs. | The prefix is set at creation and used in generated document IDs; changing it does not alter existing IDs. |
| DEP-5 | Admins may save a configured department as a reusable template. | Deferred to Release 2 (noted for roadmap). |

### 8.5 Folders

| ID | Requirement | Acceptance criteria |
|---|---|---|
| FLD-1 | Folders nest to a configurable depth (default 5) and hold both files and subfolders. | Depth is validated at creation against the effective limit; a folder lists subfolders and files together; breadcrumb shows position. |
| FLD-2 | Lowering the depth limit never orphans existing deeper folders. | Existing deeper folders remain accessible; only new folders beyond the limit are blocked. |
| FLD-3 | Subfolders inherit parent permissions by default; an admin can break inheritance to restrict a folder. | New subfolders need no setup; an override tightens access without changing the role elsewhere and can never grant more than the role allows. |
| FLD-4 | Moving a folder re-nests it and it takes on the new parent's permissions unless it has its own override. | After a move the folder resolves permissions from its new parent; its own overrides persist. |

### 8.6 Documents, identity & versioning

| ID | Requirement | Acceptance criteria |
|---|---|---|
| DOC-1 | Every document receives a unique, human-readable ID automatically at upload. | Format DEPT-TYPE-YYYY-NNNNN; unique per organization; never entered by a user. |
| DOC-2 | The ID belongs to the document, is immutable, never reused, and survives moves. | All versions share the ID; a deleted document's ID is never reissued; moving folders does not change it. |
| DOC-3 | The ID is an exact-match search shortcut. | Pasting an ID navigates directly to the document rather than returning a result list. |
| DOC-4 | Uploading a revision creates a new version, not a duplicate; nothing is overwritten. | ID and metadata carry over; the prior version drops into history; an optional 'what changed?' note labels the version. |
| DOC-5 | Earlier versions can be restored. | Restoring copies the chosen version forward as the new current version; intervening versions are retained; a new version must be the same document type. |
| DOC-6 | A title field provides the document's display name. | Lists and search results show the title value (e.g. '10428 — Anjali R.') rather than a filename. |

### 8.7 Upload & capture

| ID | Requirement | Acceptance criteria |
|---|---|---|
| UPL-1 | Documents upload via button, drag-and-drop or bulk, landing in the current folder. | The document type is inferred from the folder; system fields (department, uploader, date, file type) auto-fill. |
| UPL-2 | The upload form is generated per document type. | Fields shown match the type's schema; changing type changes the fields; only the title field is required by default. |
| UPL-3 | Bulk upload applies shared field values once across the batch, with per-file specifics on top. | Files needing no attention show 'Ready'; only exceptions require input; a mixed batch shares only common fields. |
| UPL-4 | A file matching an existing document offers 'add as new version'. | Options are add-as-version, keep both, or skip; no silent duplicate is created. |
| UPL-5 | Upload never blocks on missing optional detail. | Incomplete files save and appear in a 'needs details' queue to complete later. |
| UPL-6 | OCR runs in the background so scans become searchable. | OCR status is tracked per version; extracted text feeds search shortly after upload; failure degrades to metadata-only search. |
| UPL-7 | Uploads respect a maximum file size and OCR page ceiling. | Files over the limit are rejected with a clear message; oversized scans do not stall processing. |

### 8.8 Search & retrieval

| ID | Requirement | Acceptance criteria |
|---|---|---|
| SRCH-1 | Global search matches filename, metadata values and OCR'd document text. | Search-as-you-type returns matches across all three; results ignore folder depth. |
| SRCH-2 | A filter panel is generated from the schema, with controls by field type. | Text/ID match, dropdown multi-select, date range, number range, person picker; filters stack and combine with search. |
| SRCH-3 | Default sort is most-recent-first. | Results are ordered by recency before any query is typed. |
| SRCH-4 | Quick views provide Recent, Uploaded by me, Shared with me and Trash. | Each view lists the correct set for the current user and department. |
| SRCH-5 | Search never returns documents the user cannot access. | Confidential-folder documents and out-of-permission items never appear for non-members. |
| SRCH-6 *(v1.2)* | Every department's filter panel always shows two standard filters, with no admin setup: Document Type, and Upload Date (From – To). | From, To or both may be given; both dates are inclusive and read in the organization's time zone. They AND with each other, with schema field filters and with the search text. From after To is refused with a clear message. Results never include documents the user can't access. |

### 8.9 Document viewer

| ID | Requirement | Acceptance criteria |
|---|---|---|
| VUE-1 | The viewer previews a document in-browser with its details alongside. | Supported formats render inline; the document ID is shown, monospaced and copyable. |
| VUE-2 | Metadata is shown and editable in place under permission. | Fields match the type's schema; users without edit rights see it read-only. |
| VUE-3 | Version history is shown with restore and upload-new-version actions. | Current version is marked; earlier versions are restorable; new versions can be added from here. |
| VUE-4 | A per-document activity feed shows recent access. | Views, shares and version events appear; in a confidential folder the feed is visible only to members. |
| VUE-5 | Toolbar actions are permission-driven. | Download and share appear only when allowed; a Viewer sees a read-only screen. |

### 8.10 Sharing

| ID | Requirement | Acceptance criteria |
|---|---|---|
| SHR-1 | Documents are shared by reference, never copied. | The document stays in its home department; recipients access the original; revocation is instant and complete. |
| SHR-2 | Internal sharing targets a user, a role or a department with a permission and optional expiry. | Recipients see the item in Shared-with-me with the correct permission; the sharer sees it in Shared-by-me. |
| SHR-3 | Cross-department sharing requires the receiving department's consent. | A cross-department share may be pending until accepted; the receiving side can refuse. |
| SHR-4 | External secure links open a document for recipients without accounts, with mandatory expiry. | A link cannot be created without an expiry; access is logged; links are revocable; blocked entirely for confidential folders. |
| SHR-5 | The external-link option appears only where permitted. | Requires the External-share permission and the department's default-sharing rule allowing external links; otherwise the option is absent. |
| SHR-6 | Shared-by-me shows access counts and allows revoke, downgrade and expiry change. | Opened counts are visible; revoke is immediate; permission can be lowered and expiry extended without re-creating the share. |

### 8.11 Trash & recovery

| ID | Requirement | Acceptance criteria |
|---|---|---|
| TRSH-1 | Deleting moves a document to trash, where it is recoverable. | The item leaves normal views but remains restorable; deleting is never immediate destruction. |
| TRSH-2 | Trash shows who deleted an item, its origin, and an auto-remove countdown. | Restore returns the document to its origin folder with ID, metadata and version history intact; the countdown reflects the retention window (default 30 days). |
| TRSH-3 | Permanent purge is restricted to Department Admin and requires confirmation. | Only admins see 'Empty trash'; a hard confirmation is required; purge is the only place data truly disappears. |
| TRSH-4 *(amended v1.2)* | Items under a **Legal Hold** cannot be purged. | "Empty trash", a single permanent delete and the automatic trash purge all skip them; a held item stays in trash and can still be restored. Retention locks remain Release 2. |

### 8.12 Audit

| ID | Requirement | Acceptance criteria |
|---|---|---|
| AUD-1 | All significant events are logged. | Views, uploads, downloads, edits, deletes, restores, shares, link access, and permission/role/member changes are recorded with actor, action, target and time. |
| AUD-2 | The audit viewer filters by user, action, document and date range. | Combined filters return the correct records; action types are visually weighted. |
| AUD-3 | Audit records are immutable. | No user, including Super Admin, can edit or delete an audit record; the store is append-only. |
| AUD-4 | Audit export is available under a separate permission. | Export requires Export-audit; a role with View-audit only can inspect but not extract. |
| AUD-5 | Confidential-folder events are segregated. | Such events are visible only with the confidential-audit permission; ordinary audit views exclude them. |

### 8.13 Confidential folders

| ID | Requirement | Acceptance criteria |
|---|---|---|
| CNF-1 | A confidential folder grants access by an explicit named-user list, not roles. | Role inheritance is disabled; access is the named list only; the owner cannot be removed. |
| CNF-2 | A confidential folder is invisible to non-members everywhere. | Excluded from search, listings, counts a non-member can see, and notifications, enforced at the query layer. |
| CNF-3 | Super Admin is excluded from access; external links are blocked. | Super Admin cannot open the folder; no external link can be created for its documents; confidentiality propagates to subfolders. |
| CNF-4 | An orphaned confidential folder is recovered by dual control. | If all members are removed, restoring access requires two authorised approvers (Super Admin and Department Admin) acting together, and is logged. |
| CNF-5 | All access to confidential documents is logged. | Opens and downloads are recorded, visible only to the confidential-audit role. |

**Protection scope (R1):** confidentiality is enforced at the application layer against all users including Super Admin, but not against direct database or storage access. Folder-level encryption keyed to members is a separate, deferred decision.

### 8.14 Retention & Legal Hold *(v1.2 amendment)*

Transcribed from the v1.2 change brief. "Department Admin" means the holder of the department's retention rights (§9), which only the Department Admin role carries by default.

| ID | Requirement | Acceptance criteria |
|---|---|---|
| RET-1 | Each department may set an optional auto-delete period in whole years. | Off by default; no template switches it on; only that department's Department Admin can set, change or switch it off; departments are independent. |
| RET-2 | The period counts from each document's Upload Date — when it was first uploaded. | The Upload Date is fixed at first upload; a new version, metadata edit, move or share never changes it. The period applies to documents uploaded before it was switched on. |
| RET-3 | A daily job moves expired documents to Trash. | Runs once a day at a configurable time (default 02:00 Asia/Kolkata). Documents where Upload Date + period ≤ today, not in Trash and not under a Legal Hold (directly or through any parent folder), move to Trash with all versions, reason "Auto-deleted - retention period ended", actor System. Idempotent, batched, continues past a failing document, one audit record per document. The normal trash window then applies. |
| RET-4 | Department Admins see an Upcoming Deletions list. | Documents due within 30 days with Document ID, title, Upload Date and scheduled deletion date, soonest first; a Legal Hold can be placed from the list; confidential documents appear only to members of their folder. |
| RET-5 | A Department Admin can place and remove a Legal Hold on a document or a folder. | A reason is mandatory; who/when/why is stored, and who/when on removal. A folder hold covers all subfolders and documents added later. Inside a confidential folder, holds are placed and removed by the folder's Owner. Held documents show a "Legal Hold" badge. |
| RET-6 | A held document cannot be destroyed. | No user delete, auto-delete, "Empty trash" or automatic trash purge while held (server-enforced). A document already in Trash stays there but is never purged while held. Removing a hold lets the **next** daily run process an expired document, never immediately. |
| RET-7 | Changing the period is guarded. | Setting or shortening it first returns a preview ("N documents will be moved to Trash at the next daily run") and requires explicit confirmation; lengthening or switching off does not. Switching off stops future auto-deletes but restores nothing already removed. |
| RET-8 | Retention is audited. | Events for: auto-delete to Trash (actor System), permanent removal, hold placed (with reason), hold removed, period set / changed / switched off (old and new value), restore of an auto-deleted document. Records stay append-only, survive the document's permanent removal, and follow the confidential-audit segregation. |

Restoring an auto-deleted document is limited to a Department Admin (in a confidential folder, its Owner). It returns the document to its original folder and places a Legal Hold, reason "Restored after auto-delete", so the next daily run doesn't delete it again.

---

## 9. Permission model

Three levels, each with a defined boundary. Roles are per department; only Super Admin is global.

| Level | Role | Boundary |
|---|---|---|
| 1 | Super Admin | Organization-wide: settings, storage, departments, users, delegation. Excluded from confidential folders. |
| 2 | Department Admin | One department: members, roles (if permitted), permissions, configuration. |
| 3 | Custom roles | Per-department roles defined by an explicit permission matrix (e.g. HR Manager, Auditor, Doctor). |

**Permission catalogue (grouped).** Documents (view, upload, download, edit metadata, delete, restore, version history, preview, upload version); Folders (create, rename, delete, move); Sharing (share, remove share, create link, external share, cross-department share); Workflow (approve, reject, request changes, create workflow — inactive in R1); Search (search, advanced search, saved searches); Audit (view, export, view confidential); Members (invite, remove, change role); Configuration (create/edit/delete document type, edit metadata schema, edit rules); Retention *(v1.2)* (manage auto-delete period, place/remove Legal Hold, view upcoming deletions — Department Admin only by default; not part of the Super Admin's administrative baseline); Reports (view, export).

**Effective permission — resolution order.**

- The user's single role in that department sets the baseline.
- A folder override may only restrict further — strictest wins; it can never grant a permission the role lacks.
- Confidential folders ignore both — access is the named list only, and Super Admin is excluded.

Dependency enforcement prevents invalid roles: enabling a child permission auto-enables its parent (download/edit/delete/preview require view; external/link/cross-department share require share; restore requires trash access; export audit requires view audit).

---

## 10. Data and architecture summary

The full model is specified in the *Data Model* document. Key points relevant to requirements:

- **Tenant isolation** is the central invariant: every entity except the global user carries an organization identifier, and every query filters on it. No foreign key ever crosses organizations.
- **Membership** is the join of user, department and role — the entity that makes "one role per department, many departments per user" work, with a uniqueness constraint on (user, department).
- **Document and version are separate**: the document holds identity and metadata, each version holds a file — which is why the document ID is stable while files change.
- **Folders self-reference** via a parent pointer, giving nesting as one table.
- **Storage reference** on each version is opaque and backend-agnostic, sitting behind the storage abstraction layer.
- **Authentication tables** (refresh tokens, password-reset, email-verification, invitations, signup control) attach to the global user; refresh tokens are stored hashed and are revocable.

```
Organization → Departments → (Memberships: User + Role)
                           → Folders (nested) → Documents → Versions
                                                          → Field values
                                                          → Shares
                                                          → Audit events
```

---

## 11. Non-functional requirements

| Category | Requirement |
|---|---|
| Performance | Search response under 2 seconds; single upload under 3 clicks; 20-file bulk under 2 minutes at the stated scale. |
| Scale | Support up to 250 users per organization, ~50 concurrent, files typically under 100 MB; architecture sized for this load. |
| Availability | Standard business-hours availability; storage-connection health surfaced to the Super Admin. |
| Security | Encryption in transit and at rest; JWT with revocable refresh tokens; hashed secrets; rate-limited login; least-privilege access. |
| Tenant isolation | Complete data separation between organizations, enforced at the query layer; verified by test. |
| Auditability | Immutable, append-only audit records for all significant events. |
| Usability | Responsive web to tablet; role-appropriate landing; minimal-click upload and retrieval; English at launch. |
| Extensibility | Storage abstraction layer allowing new backends; configuration-driven sectors; reserved columns for Release 2 features. |
| Data integrity | Versioning never overwrites; document IDs immutable and unique; soft-delete with recovery window. |
| Compatibility | Formats: PDF, JPEG, PNG, DOCX, XLSX, Markdown (.md), plain text (.txt); modern browsers. |

---

## 12. Security and compliance

### 12.1 Security controls (Release 1)

- Encryption of documents in transit and at rest; storage credentials encrypted at rest and never returned to the client.
- JWT access tokens with short lifetimes; server-side, revocable refresh tokens; rotation on use.
- Password policy; single-use, time-limited reset and verification tokens; login rate-limiting and lockout.
- Role-based, least-privilege access with per-folder overrides and confidential folders.
- Complete, immutable audit trail; segregated confidential-folder audit.
- Tenant isolation enforced on every query.

### 12.2 Compliance position

Automated retention and deletion are Release 2 and depend on compliance detail still to be supplied: the applicable data-protection obligations (the DPDP Act 2023 is assumed for personal data across all sectors), medical record retention periods, statutory retention for accounts and legal records, and any external-audit access requirements. The audit trail and encryption required for compliance are delivered in Release 1; the specific retention periods (document type → years) are the input required before Release 2 retention can be built.

---

## 13. Release plan

Release 1 is the spine of a working product — a department usable end to end. Release 2 layers governance and automation on top, using data captured from Release 1.

| Module | Release |
|---|:---:|
| Identity, auth, organization, storage setup | R1 |
| Department creation, schema, roles, rules (auto-tag & sharing defaults) | R1 |
| Folders, documents, IDs, versioning, upload (single & bulk) | R1 |
| Search & filter, viewer, trash & recovery | R1 |
| Sharing (internal, cross-department, external links) | R1 |
| Audit logging, viewer and export; confidential folders | R1 |
| Retention & lifecycle automation | R2 |
| Workflow & approvals; notifications | R2 |
| Auto-extraction; reporting; admin share oversight | R2 |
| Additional storage backends; saved/global search; 2FA & SSO | R2 |

---

## 14. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Storage abstraction not built as an interface | Costly rework adding backends | Build the storage layer as a driver interface from day one |
| Broken storage credentials at setup | Uploads fail after setup | Mandatory write-read-delete test before setup completes |
| Compliance detail arrives late | Rework of R2 retention & audit | Obtain document-type → retention-period table before R2 design |
| OCR accuracy on poor scans | Search reliability below expectation | Set expectations; degrade gracefully to metadata-only search |
| Configuration complexity overwhelms admins | Poor adoption | Templates as the default path; blank configuration is the exception |
| Confidential folder lockout | Loss of access to sensitive records | Owner-cannot-be-removed guardrail plus dual-control recovery |
| Sector-specific scope creep | Erosion of the universal model | Any sector need must be expressible as configuration, or it is out of scope |
| Back-catalogue migration resurfaces | Unplanned future workstream | Acknowledged out of R1; flagged to client as a known future need |

---

## 15. Dependencies and open items

- **Compliance detail** — document type → retention period, and confirmation of applicable regulations. Required before Release 2 retention.
- **Authentication approach** — confirmed: JWT with server-side refresh tokens, self-hosted.
- **Search indexing** — whether the primary database's full-text search suffices at the stated scale or a dedicated index is warranted (implementation decision).
- **Credential key management** — approach for encrypting storage credentials, to be settled with deployment.
- **Integration** — named EMR, HRMS and finance systems and their APIs, when integration is revisited.

---

## Appendix A — BRD traceability

Confirming that every functional requirement from the original Business Requirements Document is accounted for.

| BRD requirement | Status |
|---|---|
| User authentication with roles and permissions | R1 — §8.1, §9 |
| Upload in multiple formats (PDF, JPEG, PNG, DOCX, XLSX, Markdown, plain text) | R1 — §8.7 |
| Advanced search by data, tags, file type | R1 — §8.8 |
| Auto-tagging based on predefined rules | R1 — department rules (§8.4) |
| Version control with history | R1 — §8.6 |
| Activity log for every action | R1 — §8.12 |
| Share documents through secure links | R1 — §8.10 |
| Folder-level and document-level permissions | R1 — §8.5, §9 |
| Trash and recovery features | R1 — §8.11 |
| Audit logs and activity tracking | R1 — §8.12 |
| Secure access with encryption | R1 — §12 |
| Data tagging and indexing | R1 — §8.4, §8.7 |
| Document expiry and renewal reminders | R2 — depends on compliance (§12.2) |
| Document retention policies | R2 — depends on compliance (§12.2) |
| Long-term secure archival | R2 — with retention automation |
| Integration with EMR, HRMS, Finance | Out of scope — deferred (§15) |

The four items not in Release 1 are deferred for stated reasons, not oversight. If stakeholders require retention, expiry or archival at launch, closing the compliance question becomes the critical path.

---

*End of document — Product Requirements Document, Edoc, Release 1, Version 1.0 (Draft), with the v1.2 amendment above.*
