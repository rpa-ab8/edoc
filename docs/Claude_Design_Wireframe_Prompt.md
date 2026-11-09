# Claude Design prompt — Edoc wireframes for a presentation

Copy everything below the line into Claude Design. If it is too long for one go, paste Part A + B first, then send each "Flow" section as a follow-up message ("Now design Flow 3…").

---

## PART A — Brief

You are a senior product designer. Create a **low-to-mid-fidelity wireframe set** for a web app called **Edoc**, to be used in a **stakeholder presentation**. The goal is to let a non-technical audience understand every screen, every action and how the screens connect.

**What Edoc is:** a universal, multi-sector **document management system** (healthcare, education, accounts, HR, legal…). Organisations store, organise, find, share and control access to documents. Sector differences are *configuration, not code*: an admin sets up a department from a template and the upload form, filters and search are generated from that setup.

**Core hierarchy (show this on a slide):**
Organization → Departments → Members (one role per user per department) → Folders (nestable, max depth 5) → Documents (unique ID + versions).

**Wireframe style rules**
- Greyscale wireframes, one accent colour for primary actions and the "current step". Boxes, labels and real-looking placeholder copy (no lorem ipsum) — e.g. HR documents like "Employment Contract – Anjali R.", ID `HR-CON-2026-00142`.
- Desktop-first (1440 × 900). Add one mobile-width variant only for: Login, Shared-with-me, Document Viewer.
- Every screen frame is titled `NN · Screen name` and has small numbered callouts (①②③) pointing to key elements, with a legend underneath explaining each callout (what it does, who can see it).
- Show **states** where they matter: empty, loading, error, permission-denied (action hidden, not disabled), and success toast.
- Between screens, draw **arrows labelled with the user action** that moves from one to the next ("Click Upload", "Submit", "Revoke").
- Mark any element that is **permission-dependent** with a small 🔒 tag and say which permission controls it.
- End with a **flow map** slide: every screen as a small thumbnail, arrows showing navigation.
- Deliver as a numbered frame sequence ordered exactly as the flows below, so I can drop frames straight into slides.

**Global layout (reuse everywhere)**
- Top bar: Edoc logo · organization switcher · global search box (search-as-you-type) · **Upload** button · notifications placeholder · user menu (profile, switch organization, sign out).
- Left sidebar: department switcher; quick views — **Recent, Uploaded by me, Shared with me, Trash**; then the **folder tree**. Super Admin additionally sees: Dashboard, Departments, User directory, Organization settings.
- Main panel: breadcrumb (HR › Contracts › Permanent staff › 2026), then content.
- Active filters appear as removable chips under the search bar.

**Roles to represent (use a small role badge on frames where it changes what is visible):**
1. **Super Admin** — organization-wide; creates departments, invites/disables users, storage and settings. Cannot enter confidential folders.
2. **Department Admin** — manages one department only: members, roles, permission matrix, folders, document types, rules.
3. **Custom roles** (Staff, Manager, Auditor, Finance Manager, Doctor, Recruiter…) — each defined by a permission matrix.
4. **External recipient** — no account, opens a secure link.

**Out of scope — do NOT draw:** workflow/approvals, retention locks, notifications centre, auto-extraction, reporting, standing cross-department shares, saved searches, data import. (Optionally show them as one greyed "Coming in Release 2" slide.)

---

## PART B — Flows and screens (design every one)

### Flow 1 — Account creation, sign-in and recovery
1. **Register** — email, name, password, confirm password; link "Already have an account? Sign in". Error state: email already registered → offer "Sign in instead" (no duplicate account).
2. **Verify email – pending** — "We sent a link to you@company.com", Resend button, change email.
3. **Verify email – result** — success and expired-link states.
4. **Login** — email + password, "Forgot password?", error state for wrong credentials.
5. **Forgot password** → **Reset password** (new password + confirm; success → back to Login).
6. **Select organization** — shown when the user belongs to several organizations: cards with org name, role, last used; a "Create new organization" link.
7. **Accept invitation** (arrives from an emailed link `/invitations/:token`) — two cases: *new user* (set name + password, then join) and *existing user* (just "Join Acme as HR Manager"). Show expired/used-invite error.

Note for the audience: one global account per email; organization memberships attach to it, and roles are per organization → per department.

### Flow 2 — Create organization and first-run onboarding (Super Admin)
1. **Create organization** — step indicator "1 Account ✓ → 2 Organization". Fields: organization name, **invite code** (required while signup mode is invite-code; field disappears in open mode; a "creation closed" state in disabled mode), specific field error for invalid/used code.
2. **Onboarding wizard (3 steps, with progress bar):**
   - **Step 1 – Storage (hard gate).** Choose backend: *NAS* or *Cloudflare R2*; the form changes per backend (NAS: path; R2: account ID, bucket, access key, secret). **Test connection** button runs write → read → delete; show Running / Passed ✓ / Failed ✗ with reason. **Continue is disabled until the test passes.**
   - **Step 2 – First department.** Template picker cards: Healthcare, Education, Accounts, HR, Legal, Blank. Selecting one shows a preview of the document types, roles and vocabulary it brings. (Leads into Flow 3.)
   - **Step 3 – Invite people (skippable).** Repeating rows: email · department · role · remove-row; "Add another"; buttons **Send invitations** and **Skip for now**.
3. Finish → lands on the Organization Dashboard.

### Flow 3 — Super Admin: dashboard and organization management
1. **Organization dashboard** — four stat cards (Departments, Users, Documents, Storage used); department list table with per-department members / documents / storage and a click-through; **storage connection status** pill (Connected / Error); quick actions: New department, Manage users, Templates. Add a callout: "Counts only — Super Admin never sees document contents; confidential folders count toward totals but show no names."
2. **Departments list** — table, search, **New department** button, row actions (open, edit, archive).
3. **Create department wizard** (5 steps, stepper on top, live preview on the right):
   - **Step 1 Name & template** — name, department prefix for IDs (e.g. `HR`), template cards, "Save as template" note.
   - **Step 2 Vocabulary** — "What do you manage?" (Employees / Patients / Students), primary identifier label (Employee ID); **live preview** of the Upload button reading "Add employee document".
   - **Step 3 Document types & fields (the core)** — left: list of document types (Contract, Record, Policy, Form) with Add; right: field table for the selected type with columns Name · Type (Text, ID, Dropdown, Date, Number, Person) · Required toggle · Filterable toggle · drag handle to reorder · ★ title-field marker (one per type). Callout: "One field definition becomes an upload-form field, a filter control and a search entry."
   - **Step 4 Roles & permissions** — see Flow 4.
   - **Step 5 Rules** — Default sharing (new documents visible to department only; external links on/off; auto-expiry days for links) and the Auto-delete period (optional, days; see Flow 11). Show the other R2 rules greyed out.
4. **Department detail (admin)** — tabs: Overview · Members · Roles & permissions · Document types · Folders · Rules.
5. **User directory** — table of organization users: name, email, departments & roles, status (Active / Invited / Disabled); filters; actions **Invite user**, **Disable**, **Reset password**, **Remove**. Invite modal: email + department + role rows.
6. **Organization settings** — organization profile, storage section (change backend + re-run Test connection), signup/security settings, department-creation-of-own-roles toggle.

### Flow 4 — Roles, permissions and members (Department Admin)
1. **Members tab** — table: member, role dropdown (one role per person per department), added date; **Add member** (pick from existing organization users → choose role); remove. Guardrail states: "A department must keep at least one Department Admin" (blocked remove), creator auto-assigned.
2. **Roles list** — Department Admin and Staff marked *system role – cannot be deleted*; actions **Create role, Copy, Rename, Delete** (shown only if Super Admin allowed it).
3. **Permission matrix editor** — rows grouped by area (Documents, Folders, Sharing, Search, Audit, Members, Configuration), columns = roles, ticks in cells. Show **dependency behaviour**: ticking Download auto-ticks View; External share requires Share; Export audit requires View audit (small inline hint "Also enabled: View"). Show Auditor example: View audit ✓, Export audit ✗.
4. **Effective permission explainer** panel: "Role sets the baseline → folder override can only restrict → strictest wins."

### Flow 5 — Daily workspace: browsing folders
1. **Department workspace (landing screen after login for normal users)** — sidebar + file/folder table. Columns: type icon, title (from the title field, e.g. "10428 — Anjali R."), document ID, document type, uploaded by, upload date, version, size. Folders listed first, both sortable. Toolbar: Upload, New folder, view toggle (list/grid), sort.
2. **Folder navigation** — breadcrumb and nested tree (show 4 levels), depth-limit message "Maximum folder depth reached" on create.
3. **New folder / rename / delete / move** — modal for each; **Move** shows a destination folder tree picker.
4. **Folder permissions panel** — "Inherits from parent" toggle; **Break inheritance** → own access list; note that overrides can only restrict. Add a **Confidential** toggle with a clear warning (Flow 10).
5. **Row actions** (kebab menu): Open, Download, Share, Move, Rename, Delete — with items hidden according to permission.
6. **Empty states**: empty department ("Add your first employee document"), empty folder.

### Flow 6 — Upload (single, bulk, duplicates, new version)
1. **Entry points** — Upload button, drag-and-drop overlay on the workspace ("Drop files to upload to HR › Contracts"), bulk drop.
2. **Single upload form** — generated per document type: file dropzone; document type (pre-selected from the folder); the type's fields in their configured order (e.g. Contract: Employee ID, name, start date, end date); required fields marked; dropdown remembers last choice; auto-filled read-only chips (department, uploader, date, file type). Buttons **Save** and **Save with minimum details** (goes to a "Needs details" queue). Unsupported file type error.
3. **Bulk upload screen** — **shared-fields bar** on top (document type, folder, year…) applied to all; below a file list with per-file row: name, status badge (**Ready / Needs details / Duplicate / Error**), progress bar, inline fields, remove. Footer: "12 ready · 2 need attention" and **Upload all**.
4. **Duplicate detected dialog** — "This file already exists as HR-CON-2026-00142" with three choices: **Add as new version**, **Keep both**, **Skip**.
5. **Upload progress and success** — toast "12 files uploaded. OCR running in background"; document shows a small "Indexing…" chip that disappears when searchable.
6. **Needs-details queue** — list of incomplete documents with a "Finish details" action.

### Flow 7 — Search and filter
1. **Global search** — type in top bar; dropdown with grouped live results (matches in filename, field value, and *inside document text via OCR* with highlighted snippet); pasting a Document ID jumps straight to that document.
2. **Search results page** — result list with title, ID, type, snippet, location path (depth ignored), badge for matched-in-content; sort (most recent default).
3. **Filter panel** (right or left drawer), controls generated from the document type's filterable fields: Text/ID → input; Dropdown → multi-select chips; Date → range picker; Number → range slider; Person → user picker; plus standard filters: document type, current version only, **Upload date range**. Active filters become removable chips; "Clear all".
4. Zero-results and error states.

### Flow 8 — Document viewer, metadata and versions
1. **Document viewer** — two columns. Left: preview (PDF/image/Office) with page controls and zoom. Right: details panel stacked as — **Document ID** (monospace, copy button, QR/barcode), document type, metadata fields (editable in place if the user has Edit metadata, read-only otherwise), tags, location path, **Version history**, **Activity** feed ("Seen by…"). Top toolbar: Download · Share · Delete · Upload new version (each hidden if not permitted). Add a Legal-Hold badge and an Upload-date label.
2. **Version history panel** — current version marked, earlier versions listed with number, uploader, date, "what changed?" note; per-version **Preview / Download / Restore**. Restore confirm: "Restoring copies v2 forward as a new current version v4. No versions are deleted."
3. **Upload new version** modal — file picker, optional "what changed?" note, rule hint "Must be the same document type."
4. **Edit metadata** inline-edit state with Save / Cancel and validation errors.
5. **No access / not found** screen.

### Flow 9 — Sharing (by reference, never by copy)
1. **Share dialog** — two zones separated by a divider:
   - **Internal**: add people, a role or a whole department (autocomplete); permission level dropdown (View default, Edit/Download as step-up); optional expiry date; list of current recipients with remove. Cross-department recipient shows a note "Receiving department must accept."
   - **External secure link** (zone is *absent* — not disabled — when the user lacks External share permission or the department disallows it): **mandatory expiry** date selector (no "never"), optional password, **Create link** → copyable URL with "Expires in 7 days"; list of active links with Revoke. Show that confidential folders block this zone.
2. **Shared with me** — table: document, **source department**, **shared by**, **permission badge** (View / Download / Edit), expiry countdown, filters by department and person; actions follow the permission; no move/delete/retention actions. Expired shares disappear.
3. **Shared by me** — table: document, recipient(s) (internal or "External link"), permission, expiry, **opened count** ("Never opened · expires in 2 days"), status filters Active / Expiring / Expired; row actions **Downgrade to view, Extend expiry, Revoke**; revoke confirm.
4. **Cross-department consent** — inbox banner for the receiving department admin: "Medical wants to share 3 documents with Accounts" with Accept / Decline.
5. **External link landing page** (`/l/:token`, no login, minimal branding): valid state (document preview + Download if allowed), expired state, revoked state, and a password prompt if set. Note every open is logged.

### Flow 10 — Confidential folders
1. **Create confidential folder** — toggle with explanation list: hidden from all search/listings/counts, named users only (no role inheritance), Super Admin excluded, external links blocked, subfolders inherit automatically.
2. **Access list manager** — named users with add by name; the owner row cannot be removed; remove warning.
3. **How a non-member sees it** — the same workspace *without* the folder, with a callout "Not in tree, search, recents, counts or notifications."
4. **Recovery (dual control)** — orphaned-folder request: shows two approval slots "Super Admin ✓ / Department Admin ⏳" — access restored only when both approve; fully logged.
5. Confidential events in audit log visible only to the compliance-audit role (annotate on the audit screen).

### Flow 11 — Trash, retention and Legal Hold
1. **Delete confirm** — "Move to trash? Recoverable for 30 days."
2. **Trash screen** — table: item, deleted by, original folder, deleted date, **auto-remove countdown** (turns red when near); actions **Restore** (anyone with delete rights) and **Delete permanently / Empty trash** (Department Admin only, hard confirmation by typing a word). Rows with a **Legal Hold** badge: purge buttons absent, Restore still available.
3. **Auto-deleted items** — label "Auto-deleted – retention period ended", deleted by "System"; only Department Admin sees Restore; confirm text: "Restoring places a Legal Hold so it isn't deleted again tomorrow."
4. **Legal Hold control** — on the document and folder menu: Place / Release Legal Hold with a required reason field; held items show a lock badge; callout "A hold blocks every destruction path: user delete, auto-delete, single purge, Empty trash, automatic trash purge."
5. **Department auto-delete setting** — in Rules: "Automatically delete documents N days after their upload date" (optional), with a preview "412 documents would be deleted on the next daily run" and a note that upload date is immutable and holds are skipped.

### Flow 12 — Audit log
1. **Audit log viewer** (`/w/:dept/audit`) — filter bar with four combinable filters: **User, Action, Document, Date range**; table columns: timestamp, user, action (colour-weighted badge — destructive and privilege events in red/amber), document ID/title, details. Pagination.
2. **Export audit** button (visible only with Export audit permission; Auditor sees the log but not the button) → format choice and confirmation.
3. Callouts: "Append-only: no edit or delete for anyone, including Super Admin", and "Confidential-folder events visible only to compliance-audit role".

---

## PART C — Presentation extras (create after the flows)
1. **Slide: Product concept** — two-layer diagram: universal core engine (storage, search, versioning, permissions, audit, OCR, sharing) vs configuration layer (document types, fields, roles, rules, vocabulary).
2. **Slide: Hierarchy & roles** — the Organization → Department → Role diagram with the example table *Ajilan: HR = HR Manager, Finance = Viewer, Legal = No access*.
3. **Slide: Permission resolution** — "Role sets baseline → folder can only restrict → strictest wins → confidential ignores both."
4. **Slide: Document lifecycle** — Upload → (OCR) → Version → Share → Delete → Trash → Restore/Purge, with Legal Hold branching.
5. **Slide: Full flow map** — all screens as thumbnails with navigation arrows, grouped by the 12 flows.
6. **Slide: Release 1 vs Release 2** — two columns.

Finish by listing every frame with its number and a one-line caption so I can build the deck from it.
