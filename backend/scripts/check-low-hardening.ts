/**
 * Regression checks for the low-severity hardening items in SECURITY_AUDIT.md §4 that need no
 * database: L-1 (CSV/formula injection in the audit export) and L-9 (JWT algorithm pinning).
 * Pure, side-effect free — safe to run anywhere.
 */
import jwt from "jsonwebtoken";
import { csvCell } from "../src/modules/audit/audit.service.js";
import { signAccessToken, verifyAccessToken } from "../src/lib/jwt.js";
import type { Env } from "../src/config/env.js";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  — ${detail}`}`);
}

// ── L-1: formula-leading cells are neutralised, ordinary cells untouched ──
for (const lead of ["=", "+", "-", "@", "\t", "\r"]) {
  const out = csvCell(`${lead}HYPERLINK("http://x")`);
  const unquoted = out.startsWith('"') ? out.slice(1) : out;
  check(`L-1 cell starting with ${JSON.stringify(lead)} is prefixed with '`, unquoted.startsWith("'"), out);
}
check("L-1 plain text unchanged", csvCell("Muhammed Ajilan") === "Muhammed Ajilan");
check("L-1 comma still quoted", csvCell("a,b") === '"a,b"');
check("L-1 quotes still doubled", csvCell('say "hi"') === '"say ""hi"""');
check("L-1 empty cell unchanged", csvCell("") === "");
check("L-1 formula with comma: prefixed and quoted", csvCell("=SUM(A1,B1)") === `"'=SUM(A1,B1)"`);

// ── L-9: only HS256 is accepted ──
const env = { JWT_ACCESS_SECRET: "x".repeat(48), JWT_ACCESS_EXPIRES_IN: "15m" } as unknown as Env;
const payload = { sub: "u1", emailVerified: true };
const good = signAccessToken(env, payload);
check("L-9 token signed as HS256", (jwt.decode(good, { complete: true }) as jwt.Jwt).header.alg === "HS256");
check("L-9 HS256 token verifies", verifyAccessToken(env, good).sub === "u1");

const hs512 = jwt.sign(payload, env.JWT_ACCESS_SECRET, { algorithm: "HS512" });
let rejected512 = false;
try {
  verifyAccessToken(env, hs512);
} catch {
  rejected512 = true;
}
check("L-9 HS512 token with the same secret is refused", rejected512);

const unsigned = `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${Buffer.from(
  JSON.stringify(payload),
).toString("base64url")}.`;
let rejectedNone = false;
try {
  verifyAccessToken(env, unsigned);
} catch {
  rejectedNone = true;
}
check('L-9 alg "none" token is refused', rejectedNone);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
