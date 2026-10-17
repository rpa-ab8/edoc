import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Env } from "../config/env.js";

const ALGORITHM = "aes-256-gcm";

// Storage credentials (StorageConfig.credentials) are the only data encrypted at the
// application layer today — see docs/DMS_Data_Model.md §9 and CLAUDE.md's hard rule that
// storage access only ever goes through the abstraction layer, never a raw path/SDK call
// from feature code. Key management: a single symmetric key from env (STORAGE_CREDENTIALS_KEY).

export function encryptJson(env: Env, value: unknown): string {
  const key = Buffer.from(env.STORAGE_CREDENTIALS_KEY, "base64");
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

export function decryptJson<T = unknown>(env: Env, payload: string): T {
  const key = Buffer.from(env.STORAGE_CREDENTIALS_KEY, "base64");
  const raw = Buffer.from(payload, "base64");
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}
