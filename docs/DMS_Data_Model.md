# Document Management System — Data Model

**Status:** Draft for engineering review
**Companion documents:** *DMS Feature & Flow Specification*, *DMS Scope & MVP Definition*
**Scope:** Logical model for Release 1. Entities, fields, relationships and the constraints that enforce the product rules. Storage-engine and index detail is implementation-level and noted where it matters, not prescribed.

---

## 1. Conventions

- Every table has a UUID primary key (`id`), unless noted.
- Every table except `user` carries an `organization_id` — tenant isolation is enforced at the query layer on every read and write (Section 6).
- Timestamps `created_at` and `updated_at` are on every table; omitted from field lists below for brevity.
- "Soft delete" means a `deleted_at` timestamp, not row removal (Section 5).
- Foreign keys are named `<entity>_id`.

---

## 2. Core Entities

### 2.1 organization
The top-level tenant. Everything else is scoped to it.

| Field | Type | Notes |
|---|---|---|
| id | uuid | PK |
| name | string | |
| industry | string | Optional |
| subfolder_depth_limit | int | Default 5; org-level default (Section 4.1) |
| signup_mode | enum | Not on org — this is a system-level setting; noted here for context |
| created_by_user_id | uuid | The founding Super Admin |

### 2.2 user
**Global identity — the only entity not scoped to an organization.** One row per email address across the whole system.

| Field | Type | Notes |
|---|---|---|
| id | uuid | PK |
| email | string | Globally unique |
| password_hash | string | |
| full_name | string | |
| email_verified_at | timestamp | Null until verified |
| status | enum | active, disabled — global account state |

A user reaches organizations only through `membership`. Disabling a user in one organization does not touch this row.

### 2.3 membership
**The join that defines access.** Connects a user to a department with exactly one role. This is the `user → department → role` model.

| Field | Type | Notes |
|---|---|---|
| id | uuid | PK |
| organization_id | uuid | FK |
| user_id | uuid | FK → user |
| department_id | uuid | FK → department |
| role_id | uuid | FK → role |
| status | enum | active, invited, disabled |
| invited_email | string | Set on a pending invite before the user accepts |

**Constraints:**
- Unique on (`user_id`, `department_id`) — **one role per department per user** (confirmed decision).
- A user with several memberships belongs to several departments; login resolves which via an organization picker.
- Removing a user from a department deletes the membership only; the global `user` remains.

### 2.4 department
A self-contained workspace within an organization.

| Field | Type | Notes |
|---|---|---|
| id | uuid | PK |
| organization_id | uuid | FK |
| name | string | |
| id_prefix | string | Editable department code for document IDs (e.g. "HR") |
| subject_term | string | Vocabulary — what it manages ("Employees") |
| identifier_term | string | Vocabulary — primary identifier label ("Employee ID") |
| subfolder_depth_limit | int | Nullable; overrides the org default when set (Section 4.1) |
| rules | json | Department automation rules — the spec's Step 5. Nullable; absent means defaults |
| status | enum | active, archived |

**On `rules` (added 2026-07-23).** Stored as JSON on the department for the same reason
`role.permissions` is: it is read as a whole when a document is uploaded or shared, never queried
or joined on individually. Shape in Release 1:

```
{ "defaultSharing": { "externalLinksEnabled": bool, "linkExpiryDays": int } }
```

`defaultSharing` is the safe baseline the spec asks for — external links off unless deliberately
enabled, and any link created auto-expires (Step 5). It is read by the sharing module, which still
applies its own permission checks on top: a permissive rule here never grants what a role lacks.

**Auto-tagging is deliberately absent from the R1 shape.** Neither half of it has anywhere to land
yet — a tag label has no column on `document`, and folder-conditioned rules need folders to point
at (Section 4.1, not built at the time of writing). When either arrives it becomes an additional
key inside this same JSON, not a schema change.

### 2.5 role
A named permission set, defined **per department**. Not global.

| Field | Type | Notes |
|---|---|---|
| id | uuid | PK |
| organization_id | uuid | FK |
| department_id | uuid | FK |
| name | string | "HR Manager", "Auditor", etc. |
| is_system | bool | True for built-ins (Department Admin, Staff) — undeletable |
| permissions | json | The permission matrix — map of permission-key → bool (Section 3) |

**Constraints:**
- A department retains at least one role with the Department-Admin capability at all times.
- System roles cannot be deleted (prevents orphaning).

---

## 3. Permissions

Permissions are stored as a set of boolean keys on `role.permissions` rather than as a separate table, because the catalogue is fixed and every role answers the same set. The catalogue keys, by group: documents (view, upload, download, edit_metadata, delete, restore, version_history, preview, upload_version), folders (create, rename, delete, move), sharing (share, remove_share, create_link, external_share, cross_department_share), workflow (approve, reject, request_changes, create_workflow — inactive in R1), search (search, advanced_search, saved_searches), audit (view_audit, export_audit, view_confidential_audit), members (invite, remove, change_role), configuration (create_document_type, edit_document_type, delete_document_type, edit_metadata_schema, edit_rules), reports (view_reports, export_reports).

Dependency rules (enforced in the role editor, Section 2A.7 of the spec): enabling a child key auto-enables its parent — download/edit/delete/preview require view; external_share/create_link/cross_department_share require share; restore requires trash access; export_audit requires view_audit; approve/reject/request_changes require view.

**Effective permission** is resolved at request time:
1. The user's single `role` in that department gives the baseline.
2. A `folder_permission` override may only *restrict* it further (Section 4.2).
3. Confidential folders ignore both — access is the named list only (Section 7).

Super Admin is not represented as a role; it is a property of being the organization's `created_by` / an org-admin flag, and bypasses this chain except for confidential folders.

---

## 4. Folders and Documents

### 4.1 folder
Self-referencing tree. A folder holds both subfolders and documents.

| Field | Type | Notes |
|---|---|---|
| id | uuid | PK |
| organization_id | uuid | FK |
| department_id | uuid | FK |
| parent_folder_id | uuid | FK → folder, null at department root |
| name | string | |
| is_confidential | bool | Section 7 |
| depth | int | Cached depth for limit enforcement |

**Constraints:**
- Depth is validated against the department's effective limit (own value, else org default) **at creation time only**; lowering the limit later never orphans existing deeper folders.
- `is_confidential` propagates to descendants — a child of a confidential folder is confidential and cannot be downgraded.

### 4.2 folder_permission
An override that restricts a role's access on a specific folder. Absence means inheritance.

| Field | Type | Notes |
|---|---|---|
| id | uuid | PK |
| folder_id | uuid | FK |
| role_id | uuid | FK |
| permissions | json | Restricted subset — may only remove, never add |

### 4.3 document
The identity and metadata of a document. **The file itself lives in `version`.**

| Field | Type | Notes |
|---|---|---|
| id | uuid | PK |
| organization_id | uuid | FK |
| department_id | uuid | FK |
| folder_id | uuid | FK |
| document_type_id | uuid | FK |
| document_ref | string | The human-readable ID, e.g. "HR-CON-2026-00142" |
| title_value | string | Derived from the type's title field, for list display |
| current_version_id | uuid | FK → version |
| status | enum | active, in_trash |
| workflow_state | enum | draft, pending, approved, rejected — R2, column reserved |
| deleted_at | timestamp | Soft delete — when it was moved to trash |
| deleted_by_user_id | uuid | null | Who moved it to trash, shown in the trash view (TRSH-2). Cleared on restore. |
| search_vector | tsvector | Full-text index (Module 7 / SRCH-1). Weighted `document_ref`+`title_value` (A), `field_value` values + current `version.file_name` (B), current `version.ocr_text` (C). Maintained by the app on every create / metadata edit / new version / OCR completion; GIN-indexed. Nullable until first populated. |

**Constraints:**
- `document_ref` is unique per organization, immutable, and never reused (Section 6A of the spec).
- The ID belongs to the document, so all versions share it and it survives folder moves.
- `search_vector` is derived state, never authored — it is recomputed from the document's own fields, its field values, and its current version's filename and OCR text, so search stays consistent with metadata and OCR without a separate index store (Open Item 12.1, settled).
- **Delete is two-stage (Module 11 / TRSH-1..4):** delete sets `status = in_trash` + `deleted_at` + `deleted_by_user_id` (recoverable); a Department-Admin *purge* is the only true removal — it deletes the version files, `version` / `field_value` / `share` rows and the `document` row itself. `audit_event.document_id` is `ON DELETE SET NULL` so the append-only audit trail survives a purge intact (the events keep their action, actor, timestamp and the document's ref in `target_description`); no audit row is ever updated or deleted by the application. Retention-lock enforcement (TRSH-4) is wired as a guard on purge/restore; the lock *source* is R2 (no lock is set in R1), so the guard is a no-op until then.

### 4.4 document_ref_sequence
Backs the sequential number in the document ID, scoped so numbering never collides.

| Field | Type | Notes |
|---|---|---|
| organization_id | uuid | Part of key |
| department_id | uuid | Part of key |
| document_type_id | uuid | Part of key |
| year | int | Part of key |
| last_number | int | Incremented atomically per new document |

### 4.5 version
One file. A document has many; one is current.

| Field | Type | Notes |
|---|---|---|
| id | uuid | PK |
| organization_id | uuid | FK |
| document_id | uuid | FK |
| version_number | int | 1, 2, 3 … |
| storage_ref | string | Opaque reference into the storage backend — never a raw path |
| file_name | string | Original filename |
| file_size | int | |
| mime_type | string | |
| checksum | string | SHA-256 hex of the file bytes. Backs duplicate-on-upload detection (Section 6.4 / UPL-4) — a matching checksum offers "add as new version". Nullable: legacy rows and rows whose hash wasn't recorded simply don't participate in duplicate matching. |
| ocr_status | enum | pending, done, failed |
| ocr_text | text | Extracted content, feeds search |
| change_note | string | Optional "what changed?" label |
| uploaded_by_user_id | uuid | FK → user |

**Constraints:**
- Restoring an earlier version creates a *new* version copying that file forward; intervening versions are never deleted (the chain only grows).
- A new version must share the original's `document_type_id`.
- `checksum` is recorded at upload time from the raw bytes; a restore copies the source version's checksum forward unchanged (same file). Duplicate detection is scoped to a department — a checksum match on a document the uploader can reach offers to add the file as a new version there.

---

## 5. Metadata Schema and Values

### 5.1 document_type
A category within a department (Contract, Invoice, Scan). Each has its own fields.

| Field | Type | Notes |
|---|---|---|
| id | uuid | PK |
| department_id | uuid | FK |
| name | string | |
| id_code | string | The TYPE segment of the document ID (e.g. "CON") |

### 5.2 field_def
A field definition on a document type. This single row drives the upload form, the filter control, and the search index.

| Field | Type | Notes |
|---|---|---|
| id | uuid | PK |
| document_type_id | uuid | FK |
| label | string | Shown to users |
| field_type | enum | text, id, dropdown, date, number, person |
| is_required | bool | Blocks upload if empty |
| is_filterable | bool | Appears in filters and search |
| is_title | bool | Exactly one per type — the list headline |
| options | json | For dropdown types |
| sort_order | int | Field order on the upload form |

### 5.3 field_value
The value of one field on one document.

| Field | Type | Notes |
|---|---|---|
| id | uuid | PK |
| document_id | uuid | FK |
| field_def_id | uuid | FK |
| value | string | Typed per `field_def.field_type` |

---

## 6. Sharing

### 6.1 share
A by-reference grant. No file is copied; this row records who may reach a document and how.

| Field | Type | Notes |
|---|---|---|
| id | uuid | PK |
| organization_id | uuid | FK |
| document_id | uuid | FK |
| shared_by_user_id | uuid | FK → user |
| target_type | enum | user, department, external_link |
| target_user_id | uuid | FK, when target_type = user |
| target_department_id | uuid | FK, when target_type = department |
| permission | enum | view, download |
| link_token | string | For external_link — random, unguessable |
| expires_at | timestamp | Mandatory for external_link; optional otherwise |
| status | enum | active, pending, revoked, expired |
| opened_count | int | Access count, shown in "Shared by me" |
| dismissed_at | timestamp | null | When the recipient hid this from their own "Shared with me". Recipient-side tidy only — does not affect access or the sharer's "Shared by me". |

**Constraints:**
- Cross-department shares (`target_type = department` into another department) may be created in `pending` status requiring the receiving department's acceptance (two-sided consent).
- External links require `expires_at` and are blocked entirely for documents in confidential folders.
- Revocation sets `status = revoked` — instant and complete, since no copy exists.
- `dismissed_at` lets a recipient remove a share from their own inbox without revoking it (only the sharer revokes). It is a per-recipient view preference, meaningful for `target_type = user` shares.
- Expired shares (`expires_at` in the past) are swept away automatically: they already grant no access, and are deleted when share lists are next loaded, so neither side accumulates dead rows. The audit trail of the original share still stands.

---

## 7. Confidential Folders

Confidentiality is the `folder.is_confidential` flag plus a dedicated access list. Because access is by named user rather than role, it needs its own table.

### 7.1 confidential_member
The explicit named-user access list for a confidential folder.

| Field | Type | Notes |
|---|---|---|
| id | uuid | PK |
| folder_id | uuid | FK → folder (confidential) |
| user_id | uuid | FK → user |
| is_owner | bool | Owner cannot be removed (anti-orphaning) |

**Rules enforced around this table:**
- Access is this list only — role inheritance is disabled for the folder.
- The owner cannot be removed while the folder has members; that is what prevents casual orphaning.
- Recovery of an orphaned folder requires dual-control approval (Super Admin + Department Admin), recorded in `audit_event` and tracked in `confidential_recovery`.
- Query-level exclusion: documents in confidential folders are filtered out of all search, listings, counts and notifications for non-members — enforced in the data-access layer, not the UI.
- Super Admin is excluded from access (though counts still aggregate — see Section 8).

### 7.2 confidential_recovery
Tracks a dual-control request to reopen an **orphaned** confidential folder (one with no remaining members). Because the Super Admin is excluded and role inheritance is off, no single authority can restore access; two must act together.

| Field | Type | Notes |
|---|---|---|
| id | uuid | PK |
| organization_id | uuid | FK |
| folder_id | uuid | FK → folder (confidential, orphaned) |
| new_member_user_id | uuid | FK → user — who is granted owner access when the request completes |
| initiated_by_user_id | uuid | FK → user |
| super_admin_approved_by_user_id | uuid | null | The Super Admin who approved |
| dept_admin_approved_by_user_id | uuid | null | The Department Admin who approved |
| status | enum | pending, completed, cancelled |
| created_at / completed_at | timestamp | |

**Rules enforced around this table:**
- A request may only exist for a folder with **zero** confidential members (genuinely orphaned).
- Completion requires **both** a Super Admin approval and a Department Admin approval, from two distinct people; on completion `new_member_user_id` is added to `confidential_member` as owner.
- Every initiate/approve/complete step is written to `audit_event` as a confidential event.

---

## 8. Audit

### 8.1 audit_event
An append-only record of every significant action. **Immutable** — no update or delete path exists for this table, for anyone.

| Field | Type | Notes |
|---|---|---|
| id | uuid | PK |
| organization_id | uuid | FK |
| actor_user_id | uuid | FK → user |
| action | enum | view, upload, download, edit, delete, restore, share, link_access, role_change, member_change, config_change, permission_change, workflow_transition |
| document_id | uuid | FK, nullable (some events target roles/members) |
| target_description | string | Human-readable summary of what was affected |
| department_id | uuid | FK |
| is_confidential | bool | Marks events on confidential-folder documents |
| occurred_at | timestamp | |

**Rules:**
- Append-only at the data layer; immutability is a hard guarantee.
- Confidential events (`is_confidential = true`) are visible only to holders of `view_confidential_audit`; ordinary audit views filter them out.
- Export is gated by `export_audit`, separate from view.
- Aggregate counts (storage, document totals on the dashboard) include confidential folders but expose no names or contents — the count is visible, the contents are not.

---

## 9. Storage Configuration

### 9.1 storage_config
One per organization in R1 (per-department storage is R2). Holds the backend choice and encrypted credentials.

| Field | Type | Notes |
|---|---|---|
| id | uuid | PK |
| organization_id | uuid | FK, unique in R1 |
| backend_type | enum | nas, r2 (s3 and others in R2) |
| credentials | encrypted json | Connection details — **encrypted at rest** |
| status | enum | pending, verified, error |
| last_tested_at | timestamp | Result of the write-read-delete test |
| quota_bytes | int | Storage limit |
| used_bytes | int | Running total for reporting |

**Rules:**
- The application addresses storage only through the abstraction layer; `version.storage_ref` is opaque and backend-agnostic.
- `status` must be `verified` (a passing write-read-delete test) before the organization can complete setup and store documents.
- Credentials are encrypted at rest and never returned to the client.

---

## 9A. Authentication and Account Tables

The standard plumbing every application needs, kept separate from the domain model. These attach to the global `user` (Section 2.3), not to any organization — a password reset or session belongs to the account, not a tenant.

> **Auth approach — confirmed: JWT + server-side refresh tokens.** Short-lived stateless access tokens carry the user identity; refresh tokens are stored server-side (below) so sessions stay revocable. Chosen over server sessions (better fit for multi-org and future mobile) and over a managed provider (on-prem NAS clients want identities kept in-house). Self-hosted; no third-party auth dependency.

### 9A.1 refresh_token
Server-side record of an issued refresh token, so sessions are revocable (logout, "sign out everywhere", disable account).

| Field | Type | Notes |
|---|---|---|
| id | uuid | PK |
| user_id | uuid | FK → user |
| token_hash | string | Store the hash, never the raw token |
| device_info | string | User agent / device label for the sessions list |
| ip_address | string | Issuing IP |
| expires_at | timestamp | Refresh lifetime |
| revoked_at | timestamp | Set on logout or forced revocation |
| last_used_at | timestamp | Rotation / anomaly detection |

Rules: rotate on use (issue a new refresh token, revoke the old); disabling a `user` revokes all their tokens; access tokens themselves are short-lived and not stored.

### 9A.2 password_reset_token
Backs "forgot password".

| Field | Type | Notes |
|---|---|---|
| id | uuid | PK |
| user_id | uuid | FK → user |
| token_hash | string | Hashed; the raw token goes only in the emailed link |
| expires_at | timestamp | Short (e.g. 1 hour) |
| used_at | timestamp | Single-use — null until consumed |

Rules: single-use and short-lived; requesting a new one invalidates outstanding tokens; consuming one should revoke active `refresh_token` rows (a reset logs other sessions out).

### 9A.3 email_verification_token
Backs the mandatory email verification at signup.

| Field | Type | Notes |
|---|---|---|
| id | uuid | PK |
| user_id | uuid | FK → user |
| token_hash | string | |
| expires_at | timestamp | |
| used_at | timestamp | Single-use |

On consumption, sets `user.email_verified_at`.

### 9A.4 invitation
Backs inviting a user into a department. Distinct from `membership`: the invite is the pending offer; the membership is the accepted result.

| Field | Type | Notes |
|---|---|---|
| id | uuid | PK |
| organization_id | uuid | FK |
| department_id | uuid | FK |
| role_id | uuid | FK — the role they'll get on acceptance |
| email | string | Invitee (may or may not already have an account) |
| invited_by_user_id | uuid | FK → user |
| token_hash | string | For the acceptance link |
| status | enum | pending, accepted, expired, revoked |
| expires_at | timestamp | |

Rules: on acceptance, create the `membership`; if the email already has a global `user`, link it and skip account creation; otherwise the acceptance flow includes setting a password.

### 9A.5 signup_setting
The system-level signup control (not per-organization). A single-row/global config.

| Field | Type | Notes |
|---|---|---|
| mode | enum | open, invite_code, disabled — launch value: invite_code |
| updated_by | uuid | Audit of who changed it |

### 9A.6 signup_invite_code
Valid codes when `signup_mode = invite_code`.

| Field | Type | Notes |
|---|---|---|
| id | uuid | PK |
| code | string | The code entered at org creation |
| max_uses | int | Nullable = unlimited |
| used_count | int | |
| expires_at | timestamp | Nullable |
| active | bool | |

### 9A.7 login_attempt (optional, recommended)
Rate-limiting and lockout for brute-force protection.

| Field | Type | Notes |
|---|---|---|
| id | uuid | PK |
| email | string | Attempted identifier |
| ip_address | string | |
| succeeded | bool | |
| attempted_at | timestamp | |

Supports lockout after N failures and basic abuse monitoring. Can be a fast store (e.g. cache) rather than a durable table.

### 9A.8 Notes on other common concerns

- **Two-factor authentication (2FA/MFA):** not in R1 scope; if added, a `user_mfa` table (secret, backup codes, enabled_at) attaches to `user`. Reserved.
- **SSO:** deferred (scope Section 3.9). Would add an `identity_provider` link table when introduced.
- **System settings / feature flags:** a generic `app_setting` key-value table is worth having for operational toggles beyond `signup_setting`.
- **Idempotency / background jobs (OCR, emails):** OCR runs asynchronously (`version.ocr_status`); a `job` queue table may be introduced at implementation depending on the queue technology chosen — not modelled here as it's infrastructure, not domain.

---



Every entity except `user` carries `organization_id`, and **every query filters on it without exception**. This is the single most important invariant in the model:

- No foreign key may ever cross organizations. A document, folder, role, share or audit event belongs to exactly one organization and can only reference entities within it.
- `user` is global, but its *access* is always mediated by `membership`, which is organization-scoped — so a global account still sees only the organizations it belongs to.
- Document ID sequences, storage quotas and reporting are all per organization.
- This isolation is what lets the same codebase serve one organization now and many later, with no cross-organization leakage possible by construction.

---

## 11. Entities Reserved for Later Releases

Columns and relationships already accounted for, to avoid migrations later:

- `document.workflow_state` — reserved for R2 workflow; unused in R1.
- Workflow tables (states, routing rules, approval steps) — R2.
- Retention/lifecycle tables (retention rules, locks, archive state) — R2. The audit and version tables they will build on already exist.
- Per-department `storage_config` — R2 (R1 enforces one per organization).
- Notification tables — R2.
- Reporting aggregates — R2 (raw data is captured from R1).
- `user_mfa` (two-factor) and SSO identity-provider tables — deferred; noted in Section 9A.8.

---

## 12. Open Items

1. ~~**Search index.**~~ **Settled (Module 7):** a `search_vector tsvector` column on `document`, GIN-indexed, maintained by the application from `document_ref`, `title_value`, `field_value` values, and the current `version`'s filename + `ocr_text`. No separate search engine at R1 scale (Tech Stack §3.4); revisit only if volume grows an order of magnitude.
2. **Retention periods.** The retention tables are R2 and cannot be finalised until the compliance detail (document type → period) is supplied.
3. **Credential encryption approach.** Key management for `storage_config.credentials` should be settled with the deployment decision.
