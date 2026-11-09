# Edoc — Feature & Flow Specification

**Status:** Complete functional design for Release 1 — foundation for the PRD
**Scope:** All Release 1 features and screens. Foundation decisions resolved (Section 9); companion *Scope & MVP Definition* holds phasing and open compliance detail for R2.
**Companion documents:** *Edoc Scope & MVP Definition*

---

## 1. Product Concept

Edoc: a single, universal document management system that any sector can use — healthcare, education, accounts, HR, legal, or anything added later — without rebuilding the software each time.

This is achieved by splitting the system into two layers:

**The universal core engine.** Built once, never changes per sector. It provides storage, search, versioning, the permissions engine, audit logging, OCR, encryption, and sharing. These behave identically whether the user is an eye hospital or a law firm.

**The configuration layer.** Everything sector-specific lives here as *data*, not code — document types, metadata fields, roles, retention rules, workflows, and even the vocabulary shown on screen.

The consequence: adding a new sector is a **setup task performed by an admin**, not a development project. The three sectors in the original BRD (healthcare, education, legal/corporate) become three example configurations that prove the model, rather than three separate builds.

---

## 2. Structural Model

```
User (global identity — one account per email)
   └── Membership → Organization
                       └── Super Admin (organization-scoped)
                       └── Departments (HR, Accounts, Medical, Legal, …)
                             └── Members, each holding one role per department
                             └── Folders (nestable) and document types
                                   └── Documents (each with a unique ID and versions)
```

### 2.1 Organization
The organization is the top-level data boundary and owns everything beneath it. The system is multi-organization from the start: every entity carries an organization identifier, isolation is enforced at the query layer, and no entity ever references another organization. One organization operates at launch; adding more is a new record, not a rebuild.

### 2.2 Super Admin
Scoped to a single organization, above all its departments. Creates departments, manages the organization's user directory, controls global settings and storage, and can act inside any department — **except confidential folders** (Section 11). No platform-level administrator sits above organization data; an organization's Super Admin has no visibility into any other organization.

### 2.3 Departments
Each department is a self-contained workspace with its own folders, document types, metadata fields, members, roles, and rules. A member of Medical sees only Medical unless they also belong to another department.

### 2.4 Users and roles — the critical rule
**Roles are assigned per department, not globally per user.** The unit of assignment is a triple:

> *this user → in this department → with this role*

This is what allows one person to be an HR Manager in HR and a Viewer in Finance while having no access to Legal at all. Making the role a global property of the user would make "Admin of HR only" impossible to express and would require a rebuild later.

| User | Department | Role |
|---|---|---|
| Ajilan | HR | HR Manager |
| Ajilan | Finance | Viewer |
| Ajilan | Legal | No access |

Super Admin is the sole exception — the only role that exists at organization level.

---

## 2A. Permission Model

Three levels, each with a defined boundary.

### 2A.1 Level 1 — Super Admin (organization-wide)

| Area | Capabilities |
|---|---|
| Organization | Organization settings, storage management, global configuration, department templates, organization reports |
| Departments | Create, edit, archive, delete departments |
| Users | Create, invite, disable, reset passwords, remove users |
| Delegation | Assign Department Admins; decide whether a department may create its own roles |

Super Admin sits outside the departmental permission chain entirely and can act in any department regardless of its role matrix.

### 2A.2 Level 2 — Department Admin (one department only)

A Department Admin of HR cannot manage Finance or Legal. Within their department they manage:

- **Members** — add existing organization users, remove members, change a member's role. (They do not create users; that is Super Admin.)
- **Roles** — create, copy, rename, delete roles, *if permitted by Super Admin*. Copying is the common path: duplicate Staff, rename to Finance Manager, adjust.
- **Permissions** — configure each role's matrix across upload, download, share, delete, search, audit, workflow and folder access.
- **Department configuration** — folder structure, document types, metadata, rules, workflow, notifications.

### 2A.3 Level 3 — Custom roles (per department)

Every department defines its own roles, with no coding required:

- **Finance** — Admin, Staff, Finance Manager, Auditor
- **Hospital** — Doctor, Nurse, Receptionist, Medical Records Officer
- **HR** — Recruiter, HR Executive, HR Manager

Rather than "Admin = everything," each role is defined by an explicit permission matrix.

### 2A.4 Permission catalogue

Permissions are grouped by area so that a large matrix stays readable.

| Group | Permissions |
|---|---|
| Documents | View, Upload, Download, Edit metadata, Delete, Restore, Version history, Preview |
| Folders | Create, Rename, Delete, Move |
| Sharing | Share, Remove share, Create link, External share, Cross-department share |
| Workflow | Approve, Reject, Request changes, Create workflow |
| Search | Search, Advanced search, Saved searches |
| Audit | View audit, Export audit |
| Members | Invite members, Remove members, Change roles |
| Configuration | Create/edit/delete document type, Edit metadata, Edit rules |
| Reports | View reports, Export reports |

Example matrix — the Department Admin simply ticks cells:

| Permission | Staff | Manager | Auditor |
|---|:--:|:--:|:--:|
| View documents | ✅ | ✅ | ✅ |
| Upload documents | ✅ | ✅ | ❌ |
| Edit metadata | ✅ | ✅ | ❌ |
| Delete documents | ❌ | ✅ | ❌ |
| Share documents | ✅ | ✅ | ❌ |
| External share | ❌ | ✅ | ❌ |
| View audit logs | ❌ | ✅ | ✅ |
| Create roles | ❌ | ❌ | ❌ |

Note the Auditor pattern: View Audit without Export Audit. Export is the point at which data leaves the organization, so it is granted separately.

### 2A.5 Effective permission — resolution rule

A user holds exactly one role per department, so resolution is short:

> **The role sets the baseline. A folder override may only restrict further. The strictest answer wins.** Confidential folders ignore both — access is the explicit named list only.

A folder override can never grant a permission the role lacks. Permitting that would create access invisible when auditing the role, which is how organizations lose track of who can see what. Super Admin is outside this chain (and excluded from confidential folders entirely).

### 2A.6 Folder permissions

Folders inherit from their parent by default (HR → Employees → Contracts → 2026), so new folders need no configuration. A Department Admin can **break inheritance** on any folder and give it its own access list — for example, restricting Contracts → Executives to HR Manager only. Confidential folders (Section 11) are a distinct mode where inheritance is disabled entirely.

### 2A.7 Permission dependencies

Some combinations are invalid and the interface should prevent them rather than allow a broken role to be saved. Ticking a child permission auto-enables its parent:

- Download, Edit metadata, Delete, Preview → require View
- External share, Create link, Cross-department share → require Share
- Restore → requires access to Trash
- Export audit → requires View audit
- Approve, Reject, Request changes → require View

### 2A.8 Confirmed rules

1. **One role per department.** A user may hold roles across many departments, but exactly one within each. Effective permission derives from that single role (2A.5).
2. **Cross-department sharing requires two-sided consent.** The sender holding the permission is not sufficient; the receiving department must be able to refuse inbound shares.
3. **Permanent purge is separate from Delete.** Delete moves to trash; emptying trash permanently is Department Admin only, and blocked while a retention lock is active.
4. **System roles.** Department Admin (and Staff) are undeletable built-ins, so a department can never be orphaned by deleting every role.

---

## 2B. Identity, Signup and Onboarding

### 2B.1 Global identity
A user account is global — one per email address across the whole system — and organization memberships attach to it.

```
User (global — email, password, profile)
  └── Membership in Organization A → one role per department
  └── Membership in Organization B → one role per department
```

Credentials and profile are global; roles and permissions are per organization. Inviting an email that already has an account creates a *membership*, not a second account. Disabling or removing a user in one organization has no effect on their access to another. Leaving an organization ends that membership only; it does not delete the account.

### 2B.2 Signup and organization creation
Registration creates the global account; supplying organization details creates the organization and makes that user its Super Admin. Presented as two visible steps — create account, then create organization — to match the two entities. Email verification is mandatory, and blocks *use* of the organization rather than its creation (so a mistyped address never locks someone out of the org they just made).

Organization creation is governed by a **server-side signup mode** — `open`, `invite_code`, or `disabled` — running as `invite_code` at launch. The entry point being hidden from the public interface is a convenience, not the control; enforcement is server-side. In `invite_code` mode the code field is required and validated; in `open` it disappears; in `disabled` organization creation is closed.

Edge cases: an email already registered is offered sign-in rather than a duplicate account; an invalid or used invite code returns a specific field error.

### 2B.3 Storage setup
Each organization chooses its storage backend at setup (Section 6.1) — NAS or Cloudflare R2 in R1 — and supplies its own connection details. The connection form adapts to the chosen backend. A **test connection** performs the full write-read-delete round trip (Section 6.1.1), and **setup cannot complete until it passes**. Because the organization is unusable without working storage, this is a hard gate, not a save-and-fix-later step.

### 2B.4 First-run onboarding
After creating an organization, the Super Admin is guided through three steps rather than dropped onto an empty screen:

1. **Storage** — connect and verify (hard-gated).
2. **First department** — the template picker (Section 3, Step 1).
3. **Invite people** — email + department + role rows, matching the `user → department → role` model. This step is **skippable**; unlike storage, an organization is usable without invitations, and users can be added later from the user directory.

On completion the Super Admin lands on the organization dashboard (Section 10A).

---



This is the origin point of everything downstream: folders, upload forms, filters, search and automation are all generated from what is defined here. Complexity is tamed by **templates** — the admin picks the closest preset and adjusts, rather than building from a blank canvas.

### Step 1 — Name and template
The admin names the department and chooses a starting template: Healthcare, Education, Accounts, HR, Legal, or Blank.

A template is not just a name — it is a bundle carrying the document types, fields, vocabulary, roles and rules for steps 2 through 5, already filled in. Templates are a starting point, never a cage; everything remains editable afterwards. Admins can also **save a tuned department as a new template**, so the preset library grows from real use (spinning up a second clinic becomes one click).

### Step 2 — Vocabulary
The admin sets the department's core terms: what it manages ("Employees", "Patients", "Students") and its primary identifier ("Employee ID", "Patient ID").

The system stores a generic internal concept but never displays it — it shows the configured word. The same upload button component reads "Add employee document" in HR, "Add patient document" in a clinic and "Add invoice" in Accounts. A live preview shows the change immediately.

Scope note: department vocabulary covers UI chrome — buttons, headings, placeholders, empty states. Individual field names ("Employee ID" vs "Patient ID") are simply each field's label in the schema. Between these two levels, every sector reads naturally with no sector-specific code.

### Step 3 — Document types and fields (the schema — the core)
The department contains several document types (HR: Contract, Record, Policy, Form. Accounts: Invoice, Receipt, PO, Statement. Medical: Report, Scan, Prescription). **Each document type has its own field set.**

For each field the admin defines:

| Property | Purpose |
|---|---|
| Name | The label shown to users |
| Type | Text, ID, Dropdown, Date, Number, Person — determines the input control and matching filter control |
| Required | Whether upload can proceed without it |
| Filterable | Whether it appears in the filter panel and is matched by search |
| Order | Drag to reorder; sets the sequence on the upload form so the most-used fields come first |

One field per type is marked as the **title field** — the headline shown in lists and search results. Without it, documents read as "Untitled scan"; with it, the list shows "10428 — Anjali R." at a glance.

**Why this step is foundational:** a single field definition becomes three things simultaneously — a field on the upload form, a control in the filter panel, and an entry in the search index. Define once, works everywhere; search is never configured separately. Rules in step 5 also hook onto these fields (an expiry reminder is only possible because a Date field exists).

### Step 4 — Roles and permissions
The department's roles and their permission matrix, pre-filled by the template. The full model is specified in Section 2A; this step is where it is configured.

The admin reviews the template's roles, copies and renames any that need variants (Staff → Finance Manager), and ticks or unticks cells across the permission catalogue. Whether the department may create its own roles at all is controlled by Super Admin. Dependency rules (Section 2A.7) prevent invalid combinations from being saved.

This matrix is the department **default**; folder-level overrides can tighten it in a specific subfolder without changing the role everywhere, and never loosen it.

**Members** are then added — not created here, but drawn from the organization's existing user directory and given a role in this department. Guardrails: a department must always retain at least one Department Admin (removing the last is blocked), and the creator is auto-assigned as the first.

### Step 5 — Rules and automation
Where the department begins to run itself.

**Retention** — the minimum keep period, usually a legal obligation (HR records held 7 years, financial records for the statutory audit period, medical records per health norms). On expiry of the clock the document auto-archives: it leaves the daily view but stays fully retrievable. A **retention lock** blocks deletion during the required window so nothing legally on hold can be removed, even by an Admin.

**Expiry** — the opposite direction: the document's own validity ending (a contract or licence reaching its end date), firing a renewal reminder a configured number of days beforehand. This hooks directly onto the Date field defined in step 3.

**Auto-tagging** — "when this, then that" rules that keep metadata consistent without relying on users: anything uploaded to Contracts is typed Contract and tagged Legal; an amount over a threshold could be flagged for approval. Conditions read the folder, document type, or extracted values.

**Default sharing** — the safe baseline: new documents visible to the department only, external share links off unless deliberately enabled, and any link created auto-expires. Departments differ here (HR and Medical keep external sharing off; Legal may enable it for auditors), but the default matters more than the exceptions because it applies to the thousands of documents nobody thinks to configure.

---

## 4. Department View — the daily workspace

On login the user lands directly in their department's documents, not a generic dashboard. With one department there is no picking; with several, the system remembers the last one used.

**Layout.** A left sidebar holds quick views (Recent, Uploaded by me, Shared with me, Trash) and the folder tree. The main panel shows the contents of the current folder. A persistent search bar and Upload button sit across the top, with active filters shown as removable chips.

**Folders.** Folders nest, with a default maximum depth of 5. This limit is stored as a setting so an admin can change it later; it is enforced only at the moment of folder creation, and lowering it never orphans existing deeper folders. A breadcrumb (HR › Contracts › Permanent staff › 2026) shows position at all times.

A folder holds **both files and subfolders** — everything inside is simply a child, which is either a file or a folder. The main panel lists subfolders and files together, folders first, both sortable.

**Permission inheritance.** A subfolder inherits its parent's access by default, so new folders need no setup. An admin can override a single subfolder to restrict it further, which breaks inheritance and gives it its own access list. Getting this default right means admins rarely touch permissions; getting it wrong makes every new folder a support ticket.

**Caution on depth.** Deep trees are the classic cause of buried documents — the exact problem this system exists to solve. Nesting is therefore allowed freely, but **search and tags are the primary retrieval mechanism**, not folder-diving. Search ignores depth: a file five levels down surfaces as fast as one at the top.

---

## 5. Search and Retrieval

Two complementary mechanisms, both generated automatically from the schema:

**Global search — "I roughly remember it."** One box, search-as-you-type, matching filenames, tag and field values, and — thanks to OCR — the text *inside* scans and PDFs. Results ignore folder depth.

**Filter panel — "I know exactly what I want."** Precise field values, stacked to narrow down. Each field's type determines its control:

| Field type | Filter control |
|---|---|
| Text / ID | Match or exact lookup |
| Dropdown | Multi-select chips |
| Date | Date-range picker |
| Number | Range slider |
| Person | User picker |

The two combine — search "leave policy", then filter to type Policy, current version only.

**Supporting behaviour.** Saved searches let a filter combination ("contracts expiring in 30 days") be saved as a reusable smart-folder view. Default sort is most-recent-first, so useful results appear before anyone types.

---

## 6. Upload and Capture

The design principle: **separate what the system captures from what the person types.** The schema can be rich while typing stays near zero. Rich for retrieval, light for the human.

### 6.1 Entry points
Upload button, drag-and-drop onto the view, or bulk drop of many files. All land in the current folder, which means the document type is already inferred.

### 6.2 The upload form is generated per document type
There is no single fixed upload form. The fields shown are exactly the fields defined for that document type in step 3 — a Contract in HR asks for Employee ID, name, start and end date; an Invoice in Accounts asks for vendor, bill number, amount and bill date. Same action, different fields, driven entirely by configuration.

### 6.3 Keeping it fast
- **Most fields optional.** *Filterable* and *required* are separate switches — a field can be fully searchable yet optional. Templates mark only the title field required.
- **Auto-fill the free values.** Department, uploader, date, file type and document type (inferred from the folder) are never asked.
- **Read the document.** OCR and extraction pre-fill fields where possible so the user confirms rather than types.
- **Never block.** A file can save with the minimum and anything missing goes to a "needs details" queue to finish later.
- **Remember and default.** Dropdowns default to the most common value; the form remembers the last selection.

### 6.4 Bulk upload
A **shared-fields bar** applies whatever is common to every file (all Contracts, all HR, all 2026) once, to all of them. Each file then fills its own specifics on top. Files land as "Ready" with no attention needed; the user's eyes go only to exceptions. Attention scales with problems, not with file count.

Three mechanics matter beyond the happy path:

- **Duplicate handling.** A file that already exists is not silently copied — the system offers to file it as a **new version** of the existing document, keeping one entry with its history intact (keep-both and skip are also available). This is the direct fix for the duplication and version chaos the project exists to solve.
- **Non-blocking saves.** One file needing manual entry never holds up the others.
- **Background OCR.** Runs as files land, so scans become full-text searchable shortly after upload without anyone waiting.

Formats: PDF, images and Office files (DOCX, XLSX), plus Markdown (.md) and plain text (.txt) — added 2026-11-07. Markdown is shown formatted in the viewer (raw HTML never rendered, images not auto-loaded); plain text is shown as-is. Both are full-text searchable at once, without OCR. Unsupported types are flagged rather than failing silently.

*Deferred:* auto-extraction behaviour (confidence tiers, confirm step, provenance) was designed but parked for later review. Scan-from-mobile and email-to-upload are natural future additions.

---

## 6A. Document Identity and Versioning

### 6A.1 Unique document ID
Every document receives a unique identifier automatically at upload, never entered by a user. The format is structured and human-readable — `DEPT-TYPE-YYYY-NNNNN` (e.g. `HR-CON-2026-00142`) — with the department and type prefixes drawn from the schema and the department prefix editable at creation.

Three rules define its behaviour:

- **It belongs to the document, not the file.** All versions of a document share one ID.
- **It is immutable and never reused**, including after deletion, so any historical reference always resolves to the same document.
- **It survives moves** between folders — it is identity, not location.

ID sequences are scoped per organization, so numbering never collides across organizations. The ID is an **exact-match search shortcut**: pasting it jumps straight to the document rather than returning a result list. A barcode/QR rendering on the document detail view links physical files and printed documents back to their digital record.

### 6A.2 Versioning
Uploading a revision of an existing document creates a **new version rather than a duplicate** — the ID and metadata carry over unchanged, the previous version drops into history, and nothing is ever overwritten. Two entry points:

- **Duplicate-on-upload** — a file matching an existing one offers "add as new version" (Section 6.4).
- **Upload new version from the viewer** — an explicit action beside the version history, for someone updating the document they are looking at. An optional "what changed?" note becomes the version's label.

Restoring an earlier version copies that version's file forward as the new current version; it does not delete the intervening versions, so the chain only ever grows. Both actions are gated by an **Upload new version** permission, distinct from first-time upload, and a new version must be the same document type as the original.

---



**The governing principle: share by reference, never by copy.** The document stays in its home department — one source of truth, retaining its version history, retention and audit trail — and the recipient gets access to that original. This prevents sharing from recreating the duplication problem, and makes revocation instant and complete because no copies exist to chase.

### 7.1 Three sharing modes
- **User to user or group** — a document or folder shared with named people, a role, or a whole department, with a permission level and optional expiry. Works within or across departments.
- **Standing cross-department access** — an ongoing admin-level arrangement (Medical opens a "billing-relevant reports" folder to Accounts, view-only, permanently) for workflows that repeat. *(R2.)*
- **External secure link** — a link opening the document for a recipient with no account (auditors, vendors). **Expiry is mandatory** — no permanent external link can be created — and access is logged. This is the widest exposure surface in the system, so it is doubly gated: the user needs the External share permission *and* the department's default-sharing rule must allow external links. Confidential folders block external links entirely, regardless of permission.

The share dialog presents internal sharing and external links as two separate zones with a divider, since they are different risk levels; the external zone is absent entirely where not permitted, rather than shown disabled.

### 7.2 Guardrails
Least privilege by default (sharing grants view; anything more is a deliberate step up). Cross-department shares pierce the isolation boundary, so they are gated to Admins or Staff explicitly granted a "can share" permission, and always written to the audit log. Every share is revocable and can be time-bound. The home department retains control — a recipient cannot delete a shared document, cannot override its retention, and sees new versions automatically.

Within a single department, most access already comes from the user's role; sharing there is for reaching into a restricted folder or handing a specific document to a colleague. The heavy lifting of this module is the cross-department and external cases.

### 7.3 Shared with me (the receiving side)
The recipient's inbox for everything shared to them. Each row shows three things that do the real work: the **source department** (orienting the user, since these come from outside their space), **who shared it**, and the **permission badge** (so nobody clicks Download on a view-only item). Filters by department and person; one-off and standing shares live together, distinguished by label. Expiring shares show a countdown and drop off the list when the clock runs out, leaving no stale access.

Actions follow the permission exactly. Deliberately absent: moving into own folders, deleting, or changing retention — those belong to the home department.

### 7.4 Shared by me (the control side)
Everything the user has sent out, with who has access and the power to revoke it in one place. The **opened count** is what makes this view earn its place: knowing an external share has never been opened and expires in two days makes it safe to revoke; knowing a document was opened three times shows it is in active use. Without that signal, people either revoke blindly or — more often — never revoke at all.

Alongside revoke, a share can be downgraded (edit back to view) or extended, without tearing it down and rebuilding. Active / Expiring / Expired filters keep it navigable; expired shares auto-revoke.

*Planned for later:* an **admin share oversight** view — the same screen at department scope, showing every document currently leaving the department and who holds access, with the power to revoke any of it. Personal "Shared by me" is self-service; the admin version is governance.

---

## 7A. Workflow and Approvals

Introduced by the revised permission model (Approve, Reject, Request changes, Create workflow). This is a module on the scale of sharing, not a row in a matrix — it gives documents a lifecycle state and routes them to reviewers.

### 7A.1 States

```
Draft ──submit──▶ Pending review ──approve──▶ Approved ──▶ Archived
                       │  │
      request changes ─┘  └─ reject (terminal, reason required)
                       ▼
                    back to Draft
```

Two details carry the design:

- **Documents lock while pending.** No edits between submission and decision — otherwise the file can change after the approver has read it, and the approval is meaningless.
- **Request changes is distinct from Reject.** Request changes returns the document to its owner as a live draft with a comment, and is the common real-world path, so it must be one click rather than a resubmission from scratch. Reject is terminal and requires a stated reason.

### 7A.2 Triggering
Workflow applies only where configured, set **per document type** in the department's rules (step 5). Invoices may require approval while Receipts do not. Departments with no approval needs never see the feature.

### 7A.3 Routing
- **Role-based (default)** — any holder of the approver role, e.g. any Finance Manager.
- **Named person** — a specific individual.
- **Sequential chain** — multiple approvers in order.
- **Conditional** — rules on field values, e.g. an amount above a threshold adds a second approver.

### 7A.4 Queue, notifications and audit
Everyone holding approval permission gets a **"Needs my approval"** queue. Submitters are notified of outcomes, and reminders fire on items pending too long. Every transition — submit, approve, reject, request changes — is written to the audit log with actor, timestamp and reason.

### 7A.5 Interaction with other modules
Approval state is a filterable attribute, so "pending" and "approved" are searchable. Auto-tagging and folder-move rules can fire on approval. Retention clocks should generally start from the approval date rather than upload.

**Phasing note:** the permission catalogue is ready for workflow whether or not it ships in v1. Recommendation is to treat it as phase 2 unless a stakeholder identifies an approval process that must exist at launch (Accounts invoice approval is the most likely candidate).

---

## 10A. Organization Dashboard (Super Admin)

The Super Admin's landing screen after onboarding — an overview, not a task surface. Deliberately thin in R1 (full reporting is R2): four summary figures (departments, users, documents, storage used), a department list doubling as navigation and health check (per-department member, document and storage counts), live storage-connection status, and a small set of actions (new department, manage users, department templates).

Two rules hold here. Confidential folders contribute to all counts and storage totals but expose no names or contents, so aggregates reconcile without breaching confidentiality. And the dashboard shows **counts, never contents** — the Super Admin administers the organization but has no blanket read access to department documents, and there is no org-wide "all documents" view.

## 10B. Document Viewer

The most-used screen after search. The document renders on one side; everything the system knows about it stacks on the other, so a user never leaves to check a version, copy the ID, or see who accessed it.

- **Document ID** is the header of the details panel — monospaced, copyable — because it is quoted in emails and written on physical files.
- **Metadata** shows the document type's schema fields, editable in place under the Edit metadata permission (read-only otherwise).
- **Version history** is a panel here, not a separate screen: current version marked, earlier versions restorable, plus the "upload new version" action (Section 6A.2).
- **Activity** is a short per-document feed answering "who has seen this"; the full cross-document trail is the audit viewer (10D).

Every element is permission-driven: toolbar actions (download, share) appear only if allowed, editing only with rights, and in a confidential folder the activity feed is visible only to members.

## 10C. Trash and Recovery

Deletion is two-stage: deleting moves an item to trash, where it is recoverable; it is only truly gone when the retention window lapses (default 30 days) or a Department Admin purges. Each row shows who deleted the item and its origin folder; restore returns it to that folder with ID, metadata and version history intact. An auto-remove countdown makes the window visible and turns urgent as it nears.

Two permission tiers share the screen: anyone with delete rights can restore; only a Department Admin sees "Empty trash". The overriding rule *(amended v1.2)*: an item under a **Legal Hold cannot be purged** — "Empty trash", a single permanent delete and the daily automatic purge all skip it, though it can still be restored — which is what makes holds enforceable rather than advisory. Emptying trash requires a hard confirmation. *(v1.2)* Items the daily auto-delete moved here are labelled with the reason "Auto-deleted - retention period ended" and the System as deleter; only a Department Admin may restore one, and restoring places a Legal Hold so it isn't deleted again the next day.

## 10D. Audit Log Viewer

The compliance surface the BRD calls for. Where the viewer's activity feed answers "what happened to this document", the audit viewer answers cross-cutting questions — who accessed a category of records, everything one user did, every deletion in a department — via four combinable filters: user, action, document, date range. Each record captures who, what, which document, and when.

- **All significant events are logged**, not just document actions — uploads, views, downloads, edits, deletes, shares, external-link access, and permission, role and membership changes. Action types are colour-weighted so destructive and privilege events stand out.
- **Records are immutable** — append-only, uneditable and undeletable by anyone including Super Admin. An alterable audit trail proves nothing.
- **Export is in R1** (the BRD ties audit to compliance, which means handing records to external auditors), gated by a separate Export audit permission — the Auditor role can inspect but not extract.
- **Confidential folder events** are logged but visible only to a compliance-audit role; a normal admin filtering the log never sees that a confidential document was accessed.

## 11. Confidential Folders

A distinct folder mode for the organization's most sensitive material, and the reason for the "except confidential folders" caveat throughout this document. It differs from an ordinary restricted folder in one decisive way: a restricted folder is *visible but locked*; a confidential folder is *invisible entirely*.

### 11.1 Access model
Access is an **explicit named list of users**, not roles — role inheritance is disabled for the folder. Adding access means adding a person by name; a new department manager does not gain entry automatically. The creating owner cannot be removed (first half of the anti-orphaning guardrail). **Only the owner manages the list** — other members have access but cannot add or remove anyone (decided 2026-11-07, SECURITY_AUDIT.md M-6).

### 11.2 Enforced guarantees
These are properties of the folder type, not toggles an admin casually flips:

- **Hidden from all search and listings** — enforcement is at the query level, so a title like "Termination letter — Anjali R." never surfaces in results, Recent, counts a non-member can see, or notifications.
- **Role inheritance disabled** — named list only.
- **Super Admin excluded** — the one place the Super Admin cannot reach.
- **External links blocked** — a confidential document can never leave by link.
- **Inheritance flows down** — subfolders are automatically confidential and cannot be downgraded.
- **Every open and download is logged**, visible only to the compliance-audit role.

### 11.3 Recovery (dual control)
Because no single authority sits above the folder, an orphaned folder (all members gone) cannot be reopened by one person. Restoring access requires the **Super Admin and the Department Admin to approve together**, fully logged. This is the second half of the anti-orphaning guardrail and the deliberate consequence of excluding the Super Admin.

### 11.4 Scope of protection (R1)
Protection is **application-level** in R1: the guarantees hold against all users, including Super Admin, but not against someone with direct database or storage access. Folder-level encryption keyed to members is a separate, deferred decision. The threat defended against in R1 is curious or over-privileged *application* users and accidental exposure — not a technically capable infrastructure insider.

---



| Cluster | Modules | Priority |
|---|---|---|
| Store & organize | Folders and document types, metadata and tags, version history | **R1** |
| Capture & find | Upload (single/bulk), search and filter, preview and download | **R1** |
| Share | Internal sharing, external secure links | **R1** |
| | Notifications and reminders | R2 |
| Govern & secure | Roles and permissions, trash and recovery, confidential folders | **R1** |
| | Audit log viewer and export | **R1** |
| | Retention and lifecycle automation | R2 |
| Workflow | Approval states, routing, approval queue | R2 |

**R1** = the spine of a working first version. With these, a department is usable end to end: upload a file into a folder, tag it, find it, open it, share it internally or by external link, with the right people able or unable to touch it and every action audited. R2 items layer on without changing that core.

> **Scope authority.** For the definitive release boundary, defer to the *Scope & MVP Definition* document. Where this table and that document differ, the scope document governs.

### 8.1 Designed vs. still open

**All Release 1 screens are now designed:** signup and organization creation, storage setup with test-connection, login with organization picker, first-run onboarding, organization dashboard, department view, folders, schema builder, roles matrix, department rules, search and filter, upload (single and bulk), document viewer with version history and upload-new-version, share dialog (internal and external link), Shared-with-me and Shared-by-me, trash and recovery, audit log viewer, and confidential folder management.

**Deferred to R2 (designed at concept level, not screen level):** retention and lifecycle automation, notifications, workflow and approvals, auto-extraction, reporting, admin share oversight, standing cross-department folder shares, saved searches, global cross-department search, and save-as-template.

Nothing deferred changes what is designed — it all layers onto the same organization → department → schema → sharing structure.

---

## 9. Foundation Decisions — Resolved

All foundation decisions are closed; detail is recorded in the companion *Scope & MVP Definition*. Summary:

1. **Deployment and storage.** SaaS product; storage backend chosen per organization at setup (NAS or Cloudflare R2 in R1, more in R2), behind a storage abstraction layer.
2. **Compliance and retention.** No automated retention or deletion in R1. Specific retention periods per document type are still required before R2; DPDP Act 2023 assumed for personal data.
3. **Data migration.** No import module in R1; documents are uploaded manually.
4. **Scale.** Up to 250 users, ~50 concurrent, files typically under 100 MB — a modest load.
5. **Integration.** Out of scope for now.

Confirmed detail decisions: subfolder depth default 5 (department-overridable), one role per department, two-sided cross-department share consent, dual-control confidential recovery, application-level confidential protection in R1, workflow in R2, document ID format `DEPT-TYPE-YYYY-NNNNN`, Super Admin excluded from confidential folders, multi-organization architecture, global user identity, and `invite_code` signup mode at launch.

The one open item is the **compliance and retention detail** needed before R2 — not required to build R1.

---

## 10. Design Principles (the through-line)

1. **Configuration, not code.** Anything that differs by sector is data an admin can set.
2. **Templates over blank canvases.** Power is available but never the starting point.
3. **Define once, use everywhere.** One field definition drives upload, filter and search.
4. **Rich metadata, light typing.** The system captures; the user confirms.
5. **Share by reference.** One copy, always, so history and revocation stay intact.
6. **Isolated by default, opened deliberately.** Departments are walled; every crossing is explicit, permissioned, logged and revocable.
7. **Never block the user.** Incomplete uploads save; missing details are finished later.
8. **Identity over location.** A document is its ID and metadata, not its folder path — so it survives moves, versions and shares unchanged.

