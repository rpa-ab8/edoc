/**
 * Storage targets — `npm run check:storage-targets` (backend workspace).
 *
 * SECURITY_AUDIT.md M-4. The storage settings decided where the *server* reads and writes:
 *   - a NAS `mountPath` could be any directory on the API host (the connection test writes, reads and
 *     deletes a file there, and its error text told existing paths from missing ones);
 *   - an R2 `endpoint` could be any URL, so the server sent signed requests wherever it pointed —
 *     internal services, localhost, a cloud metadata address — and reported the outcome.
 *
 * Expected now: a NAS path must resolve (symlinks followed) inside STORAGE_NAS_ROOT; R2 must be
 * https://<account>.r2.cloudflarestorage.com or an explicitly allow-listed host; the same rule holds
 * when the saved config is *used*, not only when saved; and NAS keys can't escape the mount.
 *
 * Through the real HTTP stack (`POST /storage/config` as the Super Admin) with an env that sets
 * STORAGE_NAS_ROOT to a temp directory. No external network: refused endpoints are never contacted,
 * and the allow-listed control points at a closed local port. DEV ONLY.
 */
import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import dotenv from "dotenv";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

dotenv.config({ path: "C:/apps/DMS/.env" });

import { loadEnv } from "../src/config/env.js";
import { buildApp } from "../src/app.js";
import { signAccessToken } from "../src/lib/jwt.js";
import { encryptJson } from "../src/lib/crypto.js";
import { getActiveStorageDriver } from "../src/modules/storage/storage.service.js";
import { NasDriver } from "../src/modules/storage/drivers/nas.driver.js";
import { purgeTestAuditEvents } from "./_audit-purge.js";

const prisma = new PrismaClient();
const baseEnv = loadEnv();
let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : "  → " + extra}`);
  if (ok) pass++;
  else fail++;
}

const stamp = Date.now();
const PREFIX = "zz-stgt-";
const sandbox = mkdtempSync(path.join(tmpdir(), "dms-stgt-"));
const nasRoot = path.join(sandbox, "nas-root");
const inside = path.join(nasRoot, "share");
const outside = path.join(sandbox, "outside");
mkdirSync(inside, { recursive: true });
mkdirSync(outside, { recursive: true });
const link = path.join(nasRoot, "sneaky");
let linkMade = false;
try {
  // A junction needs no admin rights on Windows; a dir symlink elsewhere.
  symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  linkMade = true;
} catch {
  /* platform without link support — that case is skipped below */
}

const env = { ...baseEnv, STORAGE_NAS_ROOT: nasRoot, STORAGE_R2_ALLOWED_HOSTS: ["localhost"] };

const owner = await prisma.user.create({
  data: { email: `${PREFIX}owner-${stamp}@example.test`, passwordHash: "x", fullName: "Owner", emailVerifiedAt: new Date() },
});
const org = await prisma.organization.create({
  data: { name: `ZZ StorageTargets ${stamp}`, industry: "test", createdByUserId: owner.id, subfolderDepthLimit: 5 },
});
let app: ReturnType<typeof buildApp> | undefined;
try {
  app = buildApp(env, prisma, new Redis(env.REDIS_URL, { lazyConnect: true }));
  await app.ready();
  const server = app;
  const auth = { authorization: `Bearer ${signAccessToken(env, { sub: owner.id, emailVerified: true, organizationId: org.id, isSuperAdmin: true })}` };
  const save = (payload: object) => server.inject({ method: "POST", url: "/storage/config", headers: auth, payload });
  const nas = (mountPath: string) => save({ backendType: "nas", mountPath });
  const r2 = (endpoint: string) =>
    save({ backendType: "r2", endpoint, bucket: "b", accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret" });
  /** The org's saved (encrypted) credentials blob — unchanged means a refused save wrote nothing. */
  const savedPath = async () => {
    const row = await prisma.storageConfig.findUnique({ where: { organizationId: org.id } });
    return row ? JSON.stringify(row.credentials) : null;
  };
  const code = (res: { body: string }) => (JSON.parse(res.body) as { error?: string }).error ?? "";

  console.log("\n── NAS mount path ──");
  const ok = await nas(inside);
  check("control: a folder inside STORAGE_NAS_ROOT is accepted", ok.statusCode === 200, `${ok.statusCode} ${ok.body.slice(0, 120)}`);
  const firstSave = await savedPath();

  const out = await nas(outside);
  check("a folder outside the root is refused", out.statusCode === 400 && code(out) === "storage_path_not_allowed", `${out.statusCode} ${out.body.slice(0, 120)}`);
  check("…and nothing was written there", readdirSync(outside).length === 0, readdirSync(outside).join(","));
  const trav = await nas(path.join(inside, "..", "..", "outside"));
  check("a ../ path that resolves outside is refused", trav.statusCode === 400 && code(trav) === "storage_path_not_allowed", `${trav.statusCode}`);
  if (linkMade) {
    const sym = await nas(link);
    check("a link inside the root that points outside is refused", sym.statusCode === 400 && code(sym) === "storage_path_not_allowed", `${sym.statusCode} ${sym.body.slice(0, 120)}`);
  } else {
    console.log("SKIP  link case (links unsupported here)");
  }
  const rel = await nas("relative/share");
  check("a relative path is refused", rel.statusCode === 400 && code(rel) === "storage_path_not_allowed", `${rel.statusCode}`);
  const sys = await nas(process.platform === "win32" ? "C:\\Windows" : "/etc");
  check("a system directory is refused", sys.statusCode === 400 && code(sys) === "storage_path_not_allowed", `${sys.statusCode}`);
  const missing = await nas(path.join(outside, "does-not-exist"));
  check(
    "a missing path gets the same answer as an existing one outside (no existence oracle)",
    missing.statusCode === out.statusCode && missing.body === out.body,
    `${missing.body.slice(0, 100)} vs ${out.body.slice(0, 100)}`,
  );
  check("…and the saved config was never replaced by a refused one", firstSave !== null && (await savedPath()) === firstSave, `${firstSave} → ${await savedPath()}`);

  console.log("\n── R2 endpoint ──");
  for (const [label, endpoint] of [
    ["plain http to localhost", "http://127.0.0.1:1/"],
    ["a cloud metadata address", "http://169.254.169.254/latest/meta-data/"],
    ["an arbitrary public host", "https://example.com/"],
    ["a look-alike host", "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com.evil.test/"],
    ["the R2 host over plain http", "http://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/"],
    ["the R2 host with embedded credentials", "https://u:p@0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/"],
    ["the R2 host on another port", "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com:8443/"],
  ] as const) {
    const res = await r2(endpoint);
    check(`refused: ${label}`, res.statusCode === 400 && code(res) === "storage_endpoint_not_allowed", `${res.statusCode} ${res.body.slice(0, 100)}`);
  }
  // Allow-listed host, closed port: passes the policy and fails the real connection test.
  const listed = await r2("https://localhost/");
  check("control: an allow-listed host passes the policy (then fails the live test normally)", listed.statusCode === 400 && code(listed) === "storage_test_failed", `${listed.statusCode} ${listed.body.slice(0, 120)}`);

  console.log("\n── the rule holds when a saved config is USED ──");
  await prisma.storageConfig.update({
    where: { organizationId: org.id },
    data: { credentials: { enc: encryptJson(env, { backendType: "nas", mountPath: outside }) } },
  });
  let refusedAtUse = false;
  try {
    await getActiveStorageDriver({ prisma, env }, org.id);
  } catch (err) {
    refusedAtUse = (err as { code?: string }).code === "storage_path_not_allowed";
  }
  check("a config pointing outside the root (written straight to the DB) can't be used", refusedAtUse);
  const retest = await server.inject({ method: "POST", url: "/storage/config/test", headers: auth });
  check("…nor re-tested", retest.statusCode === 400 && code(retest) === "storage_path_not_allowed", `${retest.statusCode} ${retest.body.slice(0, 100)}`);

  console.log("\n── NAS keys stay inside the mount ──");
  const driver = new NasDriver({ mountPath: inside });
  for (const key of ["../outside/x.txt", "..\\..\\outside\\x.txt", path.join(outside, "x.txt")]) {
    let blocked = false;
    try {
      await driver.put(key, Buffer.from("x"));
    } catch (err) {
      blocked = String(err).includes("escapes");
    }
    check(`a key "${key.slice(0, 40)}" can't escape the mount`, blocked);
  }
  check("…and nothing landed outside", readdirSync(outside).length === 0, readdirSync(outside).join(","));
  const key = await driver.put("org/doc/file.txt", Buffer.from("ok"));
  check("control: a normal key round-trips", (await driver.get(key)).toString() === "ok");

  console.log("\n── production without STORAGE_NAS_ROOT ──");
  const prodEnv = { ...env, NODE_ENV: "production" as const, STORAGE_NAS_ROOT: undefined };
  let prodRefused = "";
  try {
    await prisma.storageConfig.update({
      where: { organizationId: org.id },
      data: { credentials: { enc: encryptJson(env, { backendType: "nas", mountPath: inside }) } },
    });
    await getActiveStorageDriver({ prisma, env: prodEnv }, org.id);
  } catch (err) {
    prodRefused = (err as { code?: string }).code ?? String(err);
  }
  check("NAS is refused in production until STORAGE_NAS_ROOT is set", prodRefused === "nas_root_not_configured", prodRefused);
} catch (err) {
  check("unexpected error", false, String((err as Error).stack ?? err));
} finally {
  await app?.close();
  await purgeTestAuditEvents(prisma, { where: { organizationId: org.id } });
  await prisma.storageConfig.deleteMany({ where: { organizationId: org.id } });
  await prisma.organization.deleteMany({ where: { id: org.id } });
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
  rmSync(sandbox, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}
