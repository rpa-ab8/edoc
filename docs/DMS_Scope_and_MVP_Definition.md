# Document Management System — Scope & MVP Definition

**Status:** Draft for stakeholder review
**Purpose:** To fix what is built in the first release, what follows, and what is explicitly excluded — so that the PRD can go deep only where it matters.
**Companion document:** *DMS Feature & Flow Specification* (functional design detail)

> **How to use this document.** Sections 6 and 7 record decisions now confirmed with stakeholders. Sections 2–5 define the release scope. The remaining open item is the specific compliance and retention detail required before Release 2 (Section 6.2).

---

## 1. Product Summary

A universal Document Management System serving multiple sectors — healthcare, education, accounts, HR and legal — from a single codebase. Sector differences are handled through configuration (document types, metadata fields, roles, vocabulary, rules) rather than custom development, so a new department or sector is an administrative setup task rather than a development project.

**Primary objectives:** centralised storage, fast retrieval, controlled access, and an audit trail — with an interface deliberately optimised for minimal clicks on upload and search.

---

## 2. MVP Principle

> The MVP is the smallest system in which a department can operate **end to end** — configure itself, upload documents, find them, control who sees them, and recover from mistakes — without any manual workaround.

Everything not required to satisfy that sentence is deferred. Two consequences worth stating plainly:

- **Governance features that only matter at scale** (retention automation, reporting, exports) are deferred, but the data they depend on is captured from day one. Audit events are *logged* in v1 even though the audit *viewer* comes later. Nothing has to be retrofitted.
- **Convenience features are deferred over correctness features.** Auto-extraction and workflow can wait; permissions and version integrity cannot.

---

## 3. In Scope — Release 1 (MVP)

### 3.1 Organization layer
- **Global user identity** — one account per email address across the entire system, with organization memberships attached to it. Profile and credentials are global; roles and permissions are per organization.
- **Organization self-creation** — a person registers, supplies organization details, and becomes Super Admin of the organization they created. Fully built in front and back end.
- **Signup mode control** (server-side): `open`, `invite_code`, or `disabled`. Launch setting is `invite_code`; the signup entry point is not surfaced in the public interface. Changing mode later is configuration, not development.
- Email verification mandatory on registration.
- **Login and organization resolution** — a user belonging to one organization enters directly; a user belonging to several is shown an organization picker, and can switch organizations from within the application.
- Super Admin role, scoped to a single organization. No cross-organization visibility of any kind.
- User directory: create, invite, disable, reset password, remove users. Inviting an email that already has a global account adds a membership rather than creating a second account.
- Assignment of users to departments with a role — the core `user → department → role` model.
- Organization settings: storage, global configuration, default subfolder depth.
- **Storage backend selection at setup** — the organization chooses NAS or Cloudflare R2, supplies connection details, and verifies them with a test-connection step before completing setup (Section 6.1).
- **First-run onboarding** — after creating an organization the Super Admin is guided to configure storage, create a first department (template picker) and invite users, rather than landing on an empty screen.
- **Minimal Super Admin dashboard** — department list, user count, storage used. Reporting deferred.

### 3.2 Department creation
- Five-step creation wizard: name and template, vocabulary, document types and fields, roles and permissions, basic rules.
- **Templates shipped at launch:** Healthcare, Education, Accounts, HR, Legal, Blank.
- Schema builder: document types, custom fields (text, ID, dropdown, date, number, person), required and filterable flags, field ordering, title field.
- Department vocabulary configuration.
- *Deferred:* saving a configured department as a new reusable template.

### 3.3 Documents and folders
- Nested folders to a configurable depth (default 5), holding both files and subfolders.
- Folder create, rename, move, delete.
- Permission inheritance with the ability to break inheritance on a folder.
- **Unique document ID**, auto-generated at upload, immutable, never reused, stable across versions and moves, with exact-match search lookup.
- Version history: new versions replace without overwriting; view and restore earlier versions.
- Trash and recovery, with permanent purge restricted to Department Admin.

### 3.4 Upload
- Single upload with auto-filled system fields (department, uploader, date, type inferred from folder).
- Drag-and-drop.
- Bulk upload with a shared-fields bar applied across the batch.
- Duplicate detection offering "add as new version".
- Non-blocking save with a "needs details" queue.
- Supported formats: PDF, images (JPEG/PNG), DOCX, XLSX.
- Maximum upload size configured with margin above 100 MB; OCR subject to a page ceiling.
- **OCR** on scans and PDFs so document *content* is searchable.
- *Deferred:* auto-extraction of field values with confidence tiers.

### 3.5 Search and retrieval
- Global search across filename, metadata values, and OCR'd document text.
- Document ID exact-match shortcut.
- Filter panel generated from the schema, with controls determined by field type.
- Quick views: Recent, Uploaded by me, Shared with me, Trash.
- *Deferred:* saved searches, cross-department global search.

### 3.6 Viewing
- In-browser preview for supported formats.
- Document detail view: metadata, document ID, version history, activity.
- Download, subject to permission.

### 3.7 Permissions
- Three-level model: Super Admin → Department Admin → custom department roles.
- Per-department custom roles with a full permission matrix.
- Permission catalogue covering documents, folders, sharing, search, audit, members and configuration. *(Workflow permissions are defined in the catalogue but inactive in v1.)*
- Dependency enforcement preventing invalid role definitions.
- Effective-permission rule: role grants the baseline, folder overrides may only restrict, strictest wins.
- **Confidential folders** — explicit named-user access, invisible to non-members, excluded from all search and listings, Super Admin excluded, all access logged, with an anti-orphaning guardrail.

### 3.8 Sharing
- Internal sharing: user, role or department, by reference (never by copy).
- Permission levels on a share, with optional expiry.
- Shared with me / Shared by me views, with revoke.
- Cross-department sharing, gated by permission and logged.
- **External secure links** — time-limited links for recipients without accounts (auditors, vendors, external parties), with mandatory expiry, view-or-download permission, revocation at any time, and every access logged. Availability is controlled per department by the default-sharing rule, so departments such as HR and Medical can disable external sharing entirely.
- *Deferred:* standing cross-department folder shares, admin share oversight view.

### 3.9 Audit and security
- Audit **logging** of all significant events: view, download, upload, edit, delete, restore, share, external link access, permission and role changes, member changes, configuration changes.
- **Audit log viewer** — department-scoped, filterable by user, document, action type and date range, showing actor, action, target, timestamp and source. Access governed by the View Audit permission.
- Confidential folder access is logged and reviewable by an authorised compliance role, without exposing document contents.
- Authentication with password policy; encryption in transit and at rest.
- *Deferred:* audit export, SSO.

---

## 4. Release 2 — Post-MVP

Ordered by expected priority.

1. **Audit export** — exporting audit records for statutory audit and external review. *(The audit viewer itself is in R1.)*
2. **Retention and lifecycle automation** — retention periods, auto-archive, retention locks, expiry and renewal reminders. *Depends on compliance decisions (Section 6.2).*
3. **Notifications** — in-app and email; share notifications, expiry reminders, approval alerts.
4. **Workflow and approvals** — document states, routing, approval queue. *(Move to R1 only if a launch-critical approval process is identified — Accounts invoice approval is the likely candidate.)*
5. **Auto-extraction** — OCR-driven field pre-fill with confidence tiers and confirmation.
6. **Reporting** — organization and department dashboards, storage and usage reports.
7. **Admin share oversight** — department-wide view of all outbound shares with revocation.
8. **Standing cross-department folder shares.**
9. **Saved searches and global cross-department search.**
10. **Save-as-template** for configured departments.

---

## 5. Explicitly Out of Scope

Recorded so that expectations are set and no assumption is carried silently.

| Item | Rationale |
|---|---|
| Integration with EMR, HRMS, Finance systems | Deferred by agreement; requires named systems and API assessment before it can be scoped |
| Native mobile applications | Responsive web only; mobile app is a separate initiative |
| E-signature | Not currently a stated requirement; would be a phase-3 addition for Legal |
| Document editing in-browser | The system stores and versions documents; it does not edit them |
| Real-time collaborative editing | Not a document-management requirement |
| Email-to-upload, scan-to-upload from mobile | Convenience capture channels, phase 3 |
| AI classification, summarisation, semantic search | Not required for the stated objectives |
| Multi-organization / SaaS tenancy exposure | Architecture supports it; the feature is not exposed in this engagement |
| Physical records tracking (barcode inventory of paper files) | Distinct from document management; confirm this is genuinely not expected |
| Data migration execution | Treated as a **separate workstream** — see Section 6.3 |

---

## 6. Foundation Decisions — Resolved

Closed with stakeholder input. Remaining architectural detail noted per item.

### 6.1 Deployment and storage
**SaaS product; storage backend is chosen per organization at setup.** Each organization selects its storage during system setup and supplies its own connection details:

| Backend | Type | Availability |
|---|---|---|
| NAS | Local / on-premise | Release 1 |
| Cloudflare R2 | Cloud object storage | Release 1 |
| S3 and others | Cloud object storage | Release 2 |
| Per-department storage backends | — | Release 2 |

**Architectural requirement — a storage abstraction layer.** The application communicates with a single internal storage interface; NAS and R2 are interchangeable drivers behind it. Adding S3 or per-department backends later becomes a new driver, not a rewrite. Consequences:

- Each document stores a storage **reference**, never a raw path, so documents remain addressable regardless of backend.
- Organization-supplied connection credentials are **encrypted at rest**.
- Setup includes a **"test connection"** step, so a misconfigured NAS path or R2 credential is caught during setup rather than on first upload.

#### 6.1.1 Test-connection behaviour

The test is a **full write-read-delete round trip**, not a reachability ping, because the system must confirm at runtime it can do everything an upload and a trash-purge require. A backend that can read but not delete would pass a naive ping and then fail the first time trash is emptied.

Sequence:

1. **Connect** — validate credentials and reach the backend.
2. **Write** — put a small throwaway test object.
3. **Read back** — retrieve it and verify the contents match.
4. **Delete** — remove the test object.
5. **Pass** only if all four succeed. Any failure stops the sequence, reports the specific reason, and does not save the configuration.

**Execution is always server-side.** The setup form collects details, the backend performs the round trip, and the frontend displays only the result. This is mandatory: a NAS on an internal network is unreachable from the browser, and R2 secret keys must never reach frontend code.

**Per-backend detail** (each implemented as `testConnection()` on the backend's storage driver, so the abstraction layer stays clean as backends are added):

| Backend | Inputs | Typical failures caught |
|---|---|---|
| NAS | Mount path, credentials (SMB/NFS) | Wrong path, share not mounted, no write permission, disk full |
| Cloudflare R2 | Endpoint, bucket, access key + secret | Wrong keys, bucket missing, key lacks write or delete permission |

**Failure messages must be specific and actionable**, mapped from the backend error rather than shown as a generic "connection failed":

- Authentication error → "Access key or secret is incorrect."
- Not found → "Bucket does not exist or isn't reachable."
- Delete denied → "Credentials can write but not delete — check permissions."
- Timeout → "Couldn't reach the storage endpoint — check the address and network."

**Setup completion is blocked until the test passes.** No documents can be stored without working storage, so there is no useful half-configured state; the gate is deliberate rather than "save and fix later." Re-running the test is required whenever storage details are changed.

*Deferred to Release 2:* periodic background health checks of live storage connections (credentials rotate, mounts drop, buckets are deleted after setup). In Release 1, a failed live upload must surface a clear storage-error state rather than a silent failure.

### 6.2 Compliance and retention
**No automated retention or deletion in Release 1.** Retention periods, auto-archive and retention locks are deferred to Release 2, at which point the specific periods per document type must be supplied. Audit logging (R1) is unaffected. Applicable data-protection obligations still to be confirmed for R2 (DPDP Act 2023 assumed).

### 6.3 Data migration
**No import or migration module in Release 1.** Existing documents are uploaded manually by users. A bulk import capability is a future consideration, not a current requirement — which removes the project's single largest schedule risk from this release.

### 6.4 Scale and performance
Confirmed sizing for the launch organization:

| Parameter | Value |
|---|---|
| Total users | Up to 250 |
| Concurrent frequent users | ~50 |
| Typical file size | Under 100 MB |

This is a modest load requiring no specialised infrastructure. Two limits follow: a **maximum upload size** set with margin above 100 MB, and an **OCR page ceiling** so an unusually large scan cannot stall processing.

### 6.5 Integration
**Not in scope.** To be revisited in a future release.

---

## 7. Confirmed Decisions

Closed by stakeholder on review. These are now fixed inputs to the PRD.

| # | Decision | Resolution |
|---|---|---|
| 1 | Subfolder depth limit | Organization default of 5. A **department may override it** for itself, provided the acting role holds the settings permission. |
| 2 | Roles per user per department | **One role per department.** A user may hold roles in many departments, but exactly one within each. |
| 3 | Cross-department sharing | **Two-sided consent** — the receiving department must be able to refuse inbound shares. |
| 4 | Confidential folder recovery | **Dual control** — two authorised approvers acting together, fully logged. Never unilateral. |
| 5 | Confidential folder protection depth | **Application-level only** for the first release. Database and storage-level encryption is deferred; the limitation is accepted and documented. |
| 6 | Workflow and approvals | **Release 2.** |
| 7 | Document ID format | `DEPT-TYPE-YYYY-NNNNN`, with department prefixes editable at department creation. |
| 8 | Super Admin access to confidential folders | **Excluded.** Access is limited to the named member list. |
| 9 | Tenancy | **Multi-organization architecture built from the start.** Organizations are self-created; the creating user becomes that organization's Super Admin. There is no platform-level administrator over organization data. |
| 10 | User identity | **Global.** One account per email across the system, holding memberships in one or more organizations. |
| 11 | Signup availability | Organization creation is **fully built** but not publicly surfaced. Controlled by a server-side signup mode (`open` / `invite_code` / `disabled`), running as `invite_code` at launch and intended to become gated later. |

### 7.1 Effective permission — consolidated rule

A user holds exactly one role per department, so resolution is straightforward:

> 1. The user's **role** in that department sets the baseline.
> 2. Any **folder override** may only restrict it further — strictest wins. An override can never grant a permission the role lacks.
> 3. **Confidential folders** ignore both: access is the explicit named list only, and Super Admin is excluded.

Access in a different department is governed entirely by that department's own role assignment, independently of this one.

### 7.2 Implications of multi-organization architecture

- Every entity carries an organization identifier; isolation is enforced at the query layer, not by convention.
- No entity may ever reference another organization — documents, roles, templates, folders and audit records are all organization-scoped.
- Document ID sequences are scoped per organization, so numbering never collides.
- Storage limits and reporting are per organization.
- Department templates: system templates are shared; organization-created templates remain private to that organization.
- **Super Admin is organization-scoped.** An organization's Super Admin has no visibility into any other organization, and no platform-level administrator sits above organization data.

### 7.3 Global identity model

The user account and the organization membership are separate entities:

```
User (global — email, password, profile)
  └── Membership in Organization A  →  role in each department
  └── Membership in Organization B  →  role in each department
```

Consequences to build for:

- **Email is the global unique identifier.** Inviting an address that already has an account creates a *membership*, not a second account.
- **Login resolves organization after authentication.** One membership enters directly; several show an organization picker, with in-app switching thereafter.
- **Credentials and profile are global; everything else is per organization.** Disabling or removing a user in Organization A has no effect on their access to Organization B.
- **Leaving an organization is distinct from deleting an account.** Removal from an organization ends that membership only.
- Audit records reference the user, but are readable only within the organization where the action occurred.

### 7.4 Organization creation and signup

Registration creates a global account; supplying organization details creates the organization and makes that user its Super Admin. Email verification is mandatory.

**Signup mode is a server-side control**, not a hidden interface element. The entry point being absent from the public interface is a convenience, not a security boundary — the route remains reachable by anyone inspecting the client. Enforcement is therefore server-side:

| Mode | Behaviour |
|---|---|
| `open` | Anyone may register and create an organization |
| `invite_code` | A valid code is required — **launch setting** |
| `disabled` | Organization creation is closed entirely |

**Not exposed in this release:** per-organization billing and subscription management, and any cross-organization functionality.

**Deferred for later consideration:** an operational view for support and billing (organization count, storage per organization, subscription state) with no access to organization content.

---

## 8. Assumptions

1. Multi-organization architecture with self-created organizations and global user identity (Sections 7.2–7.4). One client organization in operation at launch.
2. Web application, responsive to tablet; no native app.
3. Departments are configured by the client's own administrators after handover.
4. Users are internal staff. External parties (auditors, vendors) have no accounts but may receive time-limited secure links.
5. Document volumes are within the range confirmed under 6.4 — pricing and architecture depend on it.
6. English-language interface at launch.
7. Confidential folder protection is application-level in this release; users with database or storage access are outside its guarantee (Section 7, decision 5).

---

## 9. MVP Success Criteria

Measurable definitions of the project's stated goals, to be validated at UAT.

| Goal | Criterion |
|---|---|
| Easy retrieval | A known document is found in **under 10 seconds**, including search response under 2 seconds |
| Minimal clicks — upload | A single document uploads in **3 clicks or fewer** from the department view |
| Minimal clicks — bulk | 20 documents of one type upload in **under 2 minutes** |
| Content searchability | Scanned documents are full-text searchable within 5 minutes of upload |
| Access control | No user can view any document outside their permitted departments and folders — verified by test matrix |
| Recoverability | Any deleted document is recoverable within the trash retention window |
| Adoption | Configured departments operate without falling back to shared drives or physical files |

---

## 10. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Storage abstraction not built as an interface | Painful rework when adding S3 / per-department storage | Build the storage layer as a driver interface from day one (6.1) |
| Organization supplies broken storage credentials | Uploads fail after setup completes | Test-connection step during setup (6.1) |
| Compliance requirements arrive late | Rework of retention and audit in R2 | Close 6.2 compliance detail before Release 2 design |
| OCR accuracy on poor-quality scans | Search reliability below expectation | Set expectations; degrade gracefully to metadata-only search |
| Configuration complexity overwhelms administrators | Poor adoption | Templates as the default path; blank configuration is the exception |
| Confidential folder lockout | Permanent loss of access to sensitive records | Anti-orphaning guardrail plus dual-control recovery (7 / decision 4) |
| Scope creep from sector-specific requests | Erosion of the universal model | Any sector-specific need must be expressible as configuration, or it is out of scope |
| Back-catalogue migration resurfaces later | Unplanned future workstream | Acknowledged as out of R1; flag to client as a known future need |

---

## 11. Next Steps

1. **Design the Release 1 gaps:** signup and organization creation, **storage setup with test-connection**, login with organization picker, first-run onboarding, preview/viewer, trash and recovery, version history, share dialog (internal and external link), audit log viewer, Super Admin dashboard, confidential folder screens.
2. Produce the PRD, deep on Release 1 only.
3. Produce supporting specifications: data model, storage abstraction interface, full permission matrix, non-functional requirements.
4. Obtain the compliance and retention detail (Section 6.2) ahead of Release 2 design.

---

## Appendix A — BRD Traceability

Confirming that all originally stated functional requirements are accounted for in Release 1.

| BRD requirement | Status |
|---|---|
| User authentication with roles and permissions | R1 — Section 3.7 |
| Upload in multiple formats (PDF, JPEG, DOCX, XLSX) | R1 — Section 3.4 |
| Advanced search by data, tags, file type | R1 — Section 3.5 |
| Auto-tagging based on predefined rules | R1 — department rules |
| Version control with history | R1 — Section 3.3 |
| Activity log for every action | R1 — Section 3.9 |
| Share documents through secure links | R1 — Section 3.8 |
| Folder-level and document-level permissions | R1 — Section 3.7 |
| Trash and recovery features | R1 — Section 3.3 |
| Audit logs and activity tracking | R1 — Section 3.9 |
| Secure access with encryption | R1 — Section 3.9 |
| Data tagging and indexing | R1 — Sections 3.2, 3.4 |
| Document expiry and renewal reminders | **R2** — depends on compliance decisions (6.2) |
| Document retention policies | **R2** — depends on compliance decisions (6.2) |
| Long-term secure archival | **R2** — with retention automation |
| Integration with EMR, HRMS, Finance | **Out of scope** — deferred by agreement (6.5) |

The four items not in Release 1 are deferred for stated reasons, not oversight. Retention, expiry and archival cannot be specified until Section 6.2 is closed; if stakeholders require any of them at launch, closing 6.2 becomes the critical path.
