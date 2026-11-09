/**
 * Product-name check — `npm run check:rename` (backend workspace). PRD v1.2 Change 1.
 *
 * The product is called **Edoc**. No user-facing text may still say "DMS" or "Document Management
 * System": the UI, the page title, email templates and the env defaults that become email sender
 * names, the README, the runbook and the docs. Needs no database.
 *
 * Deliberately *not* renamed (internal identifiers, decided to leave for now — see each_update.md):
 * the docs' file names (`docs/DMS_*.md`), the repository folder (`C:\apps\DMS`), the compose project /
 * database / volume names (`dms`, `dms-prod`, `dms_postgres_data`), the Docker image names
 * (`dms-backend`, `dms-web`) and the browser storage key `dms:currentOrganizationId`. Those are all
 * lower-case or joined to another word, so the patterns below don't match them; the one upper-case
 * exception, the folder path, is allowed explicitly.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const OLD_NAMES = [/\bDMS\b/, /Document Management System/];
// A path to the repository folder is a location, not the product's name.
const ALLOWED = [/apps[\\/]+DMS\b/];

function walk(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, exts));
    else if (exts.some((e) => full.endsWith(e))) out.push(full);
  }
  return out;
}

const files = [
  path.join(root, "frontend/index.html"),
  ...walk(path.join(root, "frontend/src"), [".ts", ".tsx", ".css"]),
  ...walk(path.join(root, "backend/src"), [".ts"]),
  path.join(root, "README.md"),
  path.join(root, "package.json"),
  path.join(root, "deploy/README.md"),
  path.join(root, "deploy/Caddyfile"),
  ...walk(path.join(root, "docs"), [".md"]),
  path.join(root, ".env.example"),
  path.join(root, ".env.production.example"),
];

let pass = 0;
let fail = 0;
for (const file of files) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const hits: string[] = [];
  lines.forEach((line, i) => {
    const cleaned = ALLOWED.reduce((text, allowed) => text.replace(new RegExp(allowed, "g"), ""), line);
    if (OLD_NAMES.some((re) => re.test(cleaned))) hits.push(`    ${i + 1}: ${line.trim().slice(0, 140)}`);
  });
  const label = path.relative(root, file);
  if (hits.length === 0) {
    pass++;
  } else {
    fail++;
    console.log(`FAIL  ${label} still says DMS / Document Management System:\n${hits.join("\n")}`);
  }
}

// The two places the name reaches people outside the app.
const html = readFileSync(path.join(root, "frontend/index.html"), "utf8");
const titleOk = /<title>Edoc<\/title>/.test(html);
console.log(`${titleOk ? "PASS" : "FAIL"}  the browser tab is titled "Edoc"`);
titleOk ? pass++ : fail++;
const env = readFileSync(path.join(root, "backend/src/config/env.ts"), "utf8");
const senderOk = /EMAIL_FROM_NAME: z\.string\(\)\.default\("Edoc"\)/.test(env);
console.log(`${senderOk ? "PASS" : "FAIL"}  emails are sent as "Edoc" by default`);
senderOk ? pass++ : fail++;

console.log(`INFO  ${files.length} user-facing files scanned`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
