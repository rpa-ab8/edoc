# 08 — Testing

The project tests behaviour with **check scripts**: TypeScript programs in `backend/scripts/check-*.ts` that run
against a real Postgres (and Redis, and sometimes real storage), print `PASS`/`FAIL` lines, clean up their own
fixtures, and exit non-zero on any failure. There is no Jest/Vitest — a check is just `tsx` running a script.

## 1. Running

```bash
npm run check:<name> --workspace backend        # one suite (loads ../.env)
```
Run them all (PowerShell, from `backend/`):
```powershell
$names = (Get-Content package.json -Raw | ConvertFrom-Json).scripts.PSObject.Properties.Name | ? { $_ -like 'check:*' }
foreach ($n in $names) { npm run $n }
```
A full run takes **10+ minutes**, mostly `check:performance` (real R2 uploads, then up to 5 minutes waiting for
OCR when no worker runs — it reports SKIPPED rather than failing). Exit code ≠ 0 means at least one `FAIL`.

**Before the first run on a machine:** the dev DB must be migrated and marked disposable
(`npm run db:mark-disposable --workspace backend`) — otherwise cleanup of audit fixtures is refused by the
append-only trigger and the script tells you so.

## 2. The suites

| Suite | Covers | Needs |
|---|---|---|
| `check:permissions` | The resolution order (role → override restricts → confidential named list; Super Admin rules) | DB |
| `check:folders` | Depth limits on create & move, cycles, confidentiality flowing down, query-layer exclusion | DB |
| `check:documents` | Document ID generator, field validation, versioning, restore-forward, lookup | DB |
| `check:upload` | Upload end-to-end: store, duplicates (new version / keep both / skip), never-block, size | DB + **Abate org's R2** |
| `check:upload-content` | Content verification (real vs disguised files, incl. Markdown/text: accepted, searchable at once, served as UTF-8 with nosniff; HTML/SVG/binary renamed refused), upload concurrency cap (HTTP) | DB, temp NAS |
| `check:search` | Full-text (title/field/filename/OCR, prefix), field filters, confidential exclusion | DB |
| `check:filters` | Document Type + Upload Date filters on the org calendar | DB |
| `check:viewer` | Detail payload, activity, preview/download gating | DB + storage |
| `check:sharing` | Internal shares, cross-dept consent, external links, expiry, revocation | DB + storage |
| `check:confidential` | Named lists, inheritance off, owner un-removable, SA excluded, invisibility, recovery | DB |
| `check:vault-owner` | Only the owner manages the list (HTTP) | DB |
| `check:trash` | Soft delete, trash view, restore, DA purge | DB + storage |
| `check:retention` | Auto-delete setting, immutable Upload Date, daily run, trash purge, upcoming list | DB |
| `check:legal-hold` | Holds stop every destruction path; who may place/remove | DB |
| `check:audit` | Filters, confidential segregation, export gating | DB |
| `check:audit-immutability` | DB refuses UPDATE/DELETE/TRUNCATE on `audit_event` (probes always rolled back) | DB (marked) |
| `check:tenant-isolation` | Nothing crosses organizations | DB |
| `check:access-matrix` | The PRD's "no one sees outside their departments/folders" matrix | DB |
| `check:department-binding` | A folder can't be acted on under another department's URL (H-1, HTTP) | DB, temp NAS |
| `check:share-exposure` | Share recipients/no-history roles get trimmed responses (H-2, HTTP) | DB, temp NAS |
| `check:role-escalation` | Role editing bounded by your own access (H-3, HTTP) | DB |
| `check:member-hierarchy` | Can't act on members above you (M-7, HTTP) | DB |
| `check:link-revalidation` | External links die when their conditions lapse (H-4, HTTP) | DB, temp NAS |
| `check:session-revocation` | Disabled accounts/members lose access immediately (M-2, HTTP) | DB + Redis |
| `check:login-lockout` | Lockout per (email, IP) + trusted-IP step-up (M-3, HTTP) | DB + Redis |
| `check:storage-targets` | NAS root / R2 host allow-lists (M-4, HTTP) | DB, temp dirs |
| `check:performance` | Search < 2 s, 20-file bulk upload < 2 min, OCR searchable < 5 min | **Abate org's R2**, optional OCR worker |
| `check:rename` | No user-facing text uses the old product name (the product is Edoc) | none (no DB) |

**CI** (`.github/workflows/ci.yml`) runs lint, typecheck, frontend build, `prisma migrate deploy` on a fresh DB,
`db-mark-disposable`, then `check:audit-immutability`, `check:tenant-isolation` and `check:access-matrix` — the
suites that build all their own fixtures. The rest expect the dev DB's real organizations and storage.

## 3. Anatomy of a check script

```ts
import { PrismaClient } from "@prisma/client";
import { purgeTestAuditEvents } from "./_audit-purge.js";
import { pdfBytes } from "./_fixture-files.js";
import { Redis } from "ioredis";
import dotenv from "dotenv";
dotenv.config({ path: "C:/apps/DMS/.env" });
import { loadEnv } from "../src/config/env.js";
import { buildApp } from "../src/app.js";
import { signAccessToken } from "../src/lib/jwt.js";

const prisma = new PrismaClient();
const env = loadEnv();
let pass = 0, fail = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : "  → " + extra}`);
  ok ? pass++ : fail++;
}

const stamp = Date.now();
const PREFIX = "zz-mytest-";                       // every fixture user email starts with this
const owner = await prisma.user.create({ data: { email: `${PREFIX}owner-${stamp}@example.test`, … } });
const org = await prisma.organization.create({ data: { name: `ZZ MyTest ${stamp}`, createdByUserId: owner.id, … } });
let app: ReturnType<typeof buildApp> | undefined;
try {
  // …create departments, roles, members, folders INSIDE try so cleanup always runs…
  app = buildApp(env, prisma, new Redis(env.REDIS_URL, { lazyConnect: true }));
  await app.ready();
  const auth = { authorization: `Bearer ${signAccessToken(env, { sub: user.id, emailVerified: true, organizationId: org.id, isSuperAdmin: false })}` };
  const res = await app.inject({ method: "GET", url: "/departments", headers: auth });
  check("control: member lists departments", res.statusCode === 200, res.body);
} catch (err) {
  check("unexpected error", false, String((err as Error).stack ?? err));
} finally {
  await app?.close();
  await purgeTestAuditEvents(prisma, { where: { organizationId: org.id } });  // the only sanctioned audit delete
  // …delete children before parents (versions, documents, folders, memberships, roles, departments)…
  await prisma.organization.deleteMany({ where: { id: org.id } });
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}
```

Rules that keep the suite trustworthy:
1. **Pair every refusal with a positive control** (the same call by someone allowed, or on their own data) — so a
   check can't pass because the feature is simply broken.
2. **Verify refusals in the database**, not just the status code (nothing was written).
3. **HTTP-level** (`app.inject`) for anything about route wiring, guards or responses; **service-level** for
   pure rules.
4. **Prove the test catches the bug**: run it against the pre-fix code first (for the security suites this was done
   by temporarily restoring the committed files) — a test that never failed proves nothing.
5. **Fixtures**: unique `stamp`, the `PREFIX` convention, everything created inside `try`, cleanup in `finally`
   — and **always a `catch` that records `check("unexpected error", false, …)`**. A `try/finally` without it
   lets an exception skip every later check while the script still exits 0 (this hid a broken reference in
   `check:upload` for a while). Watch the PASS count, not just the exit code.
6. **Real files**: uploads are verified by content — use `scripts/_fixture-files.ts`
   (`pdfBytes`, `pngBytes`, `jpegBytes`, `docxBytes`, `xlsxBytes`, `markdownBytes`, `textBytes`, `plainZipBytes`,
   each takes a salt). Don't shadow these names with local variables.
7. **Storage** for HTTP tests: a `storage_config` row with `backendType: "nas"`, `status: "verified"` and
   `credentials: { enc: encryptJson(env, { backendType: "nas", mountPath: <temp dir> }) }` (allowed in dev because
   `STORAGE_NAS_ROOT` is unset).
8. **Destructive probes** (e.g. TRUNCATE) must run inside a transaction that always rolls back.
9. Add the script to `backend/package.json` as `check:<name>`.

Helpers: `_audit-purge.ts` (`purgeTestAuditEvents`), `_fixture-files.ts`, `_retention-fixtures.ts` (shared
retention/hold world builder), `db-mark-disposable.ts`.

## 4. Known flakiness

- `check:legal-hold` "a Department Admin can, and who/when/why is stored" compares a DB-generated `placedAt` with
  the host clock — Docker's clock can drift slightly. Re-run; if it recurs, widen the window.
- `check:performance` depends on network to R2 and on whether the OCR worker is running.

## 5. Manual verification

Business-visible changes should also be clicked through in the browser (dev servers on 5173/4000) with the test
accounts in `CLAUDE.local.md`. Record what was verified in `each_update.md`.
