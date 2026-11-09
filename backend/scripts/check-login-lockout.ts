/**
 * Login lockout — `npm run check:login-lockout` (backend workspace).
 *
 * SECURITY_AUDIT.md M-3. Failures were counted per email only: 5 wrong passwords from anywhere
 * locked the account for 15 minutes, so anyone who knew an email could keep its owner locked out
 * indefinitely with 5 requests per 15 minutes.
 *
 * Expected now:
 *   - 5 failures lock the (email, IP) pair — the attacker's IP, not the owner;
 *   - the owner still signs in from their usual IP, or a new one, while the attacker is locked;
 *   - a distributed attack (many IPs) past the per-account ceiling locks out *new* IPs, but an IP
 *     this account has signed in from recently still gets through;
 *   - unknown emails are throttled identically (no difference to probe).
 *
 * Through the real HTTP stack (`app.inject` with `remoteAddress`). DEV ONLY.
 */
import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import dotenv from "dotenv";

dotenv.config({ path: "C:/apps/DMS/.env" });

import { loadEnv } from "../src/config/env.js";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/lib/password.js";

const prisma = new PrismaClient();
const env = loadEnv();
let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : "  → " + extra}`);
  if (ok) pass++;
  else fail++;
}

const stamp = Date.now();
const PREFIX = "zz-lock-";
const email = `${PREFIX}victim-${stamp}@example.test`;
const ghost = `${PREFIX}ghost-${stamp}@example.test`;
const PASSWORD = "correct horse battery staple";
const redis = new Redis(env.REDIS_URL);
let app: ReturnType<typeof buildApp> | undefined;

async function clearRedis() {
  for (const e of [email, ghost]) {
    const keys = await redis.keys(`login:*${e}*`);
    if (keys.length) await redis.del(...keys);
  }
}

try {
  await prisma.user.create({
    data: { email, passwordHash: await hashPassword(PASSWORD), fullName: "Victim", emailVerifiedAt: new Date() },
  });
  await clearRedis();

  app = buildApp(env, prisma, new Redis(env.REDIS_URL, { lazyConnect: true }));
  await app.ready();
  const server = app;
  const login = (who: string, password: string, ip: string) =>
    server.inject({ method: "POST", url: "/auth/login", payload: { email: who, password }, remoteAddress: ip });

  const HOME = "10.0.0.1";
  const ATTACKER = "10.9.9.9";

  const first = await login(email, PASSWORD, HOME);
  check("setup: the owner signs in from home", first.statusCode === 200, `${first.statusCode} ${first.body.slice(0, 120)}`);

  console.log("\n── one attacker IP hammering the account ──");
  for (let i = 0; i < env.LOGIN_MAX_ATTEMPTS; i++) await login(email, "wrong", ATTACKER);
  const attackerAgain = await login(email, PASSWORD, ATTACKER);
  check("the attacker's IP is locked (even with the right password)", attackerAgain.statusCode === 429, `${attackerAgain.statusCode}`);
  const owner = await login(email, PASSWORD, HOME);
  check("the owner can STILL sign in from home", owner.statusCode === 200, `${owner.statusCode} ${owner.body.slice(0, 120)}`);
  const ownerNew = await login(email, PASSWORD, "10.0.0.2");
  check("the owner can STILL sign in from a new IP", ownerNew.statusCode === 200, `${ownerNew.statusCode} ${ownerNew.body.slice(0, 120)}`);
  const attackerStill = await login(email, PASSWORD, ATTACKER);
  check("…and the owner's success does not unlock the attacker's IP", attackerStill.statusCode === 429, `${attackerStill.statusCode}`);

  console.log("\n── unknown email: throttled the same way ──");
  for (let i = 0; i < env.LOGIN_MAX_ATTEMPTS; i++) await login(ghost, "wrong", ATTACKER);
  const ghostAgain = await login(ghost, "wrong", ATTACKER);
  check("guessing an unknown email is throttled after the same number of tries", ghostAgain.statusCode === 429, `${ghostAgain.statusCode}`);

  console.log("\n── a distributed attack past the per-account ceiling ──");
  await clearRedis();
  for (let i = 0; i < env.LOGIN_MAX_ATTEMPTS_PER_ACCOUNT; i++) {
    await login(email, "wrong", `10.50.${Math.floor(i / 250)}.${(i % 250) + 1}`);
  }
  const newIp = await login(email, PASSWORD, "10.77.7.7");
  check("a never-seen IP is refused once the account is under attack", newIp.statusCode === 429, `${newIp.statusCode}`);
  const home = await login(email, PASSWORD, HOME);
  check("the owner's recently-used IP still gets through", home.statusCode === 200, `${home.statusCode} ${home.body.slice(0, 120)}`);
  const wrongFromHome = await login(email, "wrong", HOME);
  check("…but only with the right password (normal failure there)", wrongFromHome.statusCode === 401, `${wrongFromHome.statusCode}`);
} catch (err) {
  check("unexpected error", false, String((err as Error).stack ?? err));
} finally {
  await app?.close();
  await clearRedis();
  redis.disconnect();
  await prisma.loginAttempt.deleteMany({ where: { email: { startsWith: PREFIX } } });
  await prisma.refreshToken.deleteMany({ where: { user: { email: { startsWith: PREFIX } } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });

  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}
