import { createHash, randomBytes } from "node:crypto";

/** A single-use opaque token: the raw value goes to the client (email link, cookie);
 * only its hash is ever persisted, per the data model's token tables (section 9A). */
export interface IssuedToken {
  raw: string;
  hash: string;
}

export function issueToken(): IssuedToken {
  const raw = randomBytes(32).toString("hex");
  return { raw, hash: hashToken(raw) };
}

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}
