import type { PrismaClient } from "@prisma/client";
import type { Env } from "../../config/env.js";
import { decryptJson, encryptJson } from "../../lib/crypto.js";
import { logAuditEvent } from "../../lib/audit.js";
import { NasDriver } from "./drivers/nas.driver.js";
import { R2Driver } from "./drivers/r2.driver.js";
import type { StorageDriver } from "./drivers/types.js";
import type { StorageConfigInput } from "./storage.schemas.js";

export class StorageConfigError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

interface Deps {
  prisma: PrismaClient;
  env: Env;
}

function buildDriver(input: StorageConfigInput): StorageDriver {
  if (input.backendType === "nas") {
    return new NasDriver({
      mountPath: input.mountPath,
      username: input.username,
      password: input.password,
    });
  }
  return new R2Driver({
    endpoint: input.endpoint,
    bucket: input.bucket,
    accessKeyId: input.accessKeyId,
    secretAccessKey: input.secretAccessKey,
  });
}

/**
 * The org's live storage driver, built from its saved (encrypted) credentials — the single seam
 * feature code (Upload, the OCR worker, the future Viewer) uses to read/write files. Storage is
 * only ever reached through this, never a raw SDK/filesystem call (CLAUDE.md hard rule).
 *
 * Credentials are decrypted here and never leave this module. Refuses when no storage is connected;
 * does not hard-gate on `status`, which can be stale — a genuinely unreachable backend surfaces as
 * a real error from the actual `put`/`get`, not a guess from a cached flag.
 */
export async function getActiveStorageDriver(deps: Deps, organizationId: string): Promise<StorageDriver> {
  const { prisma, env } = deps;
  const config = await prisma.storageConfig.findUnique({ where: { organizationId } });
  if (!config) {
    throw new StorageConfigError(400, "storage_not_configured", "Connect a storage backend before uploading.");
  }
  const stored = config.credentials as { enc?: string } | null;
  if (!stored?.enc) {
    throw new StorageConfigError(500, "storage_credentials_unreadable", "The saved storage credentials could not be read. Reconnect the backend.");
  }
  return buildDriver(decryptJson<StorageConfigInput>(env, stored.enc));
}

/** Adjusts the org's recorded storage usage. Positive on upload, negative if bytes are ever freed. */
export async function recordStorageUsage(deps: Deps, organizationId: string, deltaBytes: number): Promise<void> {
  if (deltaBytes === 0) return;
  await deps.prisma.storageConfig.updateMany({
    where: { organizationId },
    data: { usedBytes: { increment: BigInt(deltaBytes) } },
  });
}

export async function getStorageStatus(deps: Deps, organizationId: string) {
  const config = await deps.prisma.storageConfig.findUnique({ where: { organizationId } });
  if (!config) return null;
  return {
    backendType: config.backendType,
    status: config.status,
    lastTestedAt: config.lastTestedAt,
    quotaBytes: config.quotaBytes !== null ? config.quotaBytes.toString() : null,
    usedBytes: config.usedBytes.toString(),
  };
}

/**
 * Re-runs the write → read-back → delete round trip against the *already saved* credentials, so
 * the Super Admin can check a live connection without re-entering secrets (PRD §11: "storage-
 * connection health surfaced to the Super Admin").
 *
 * Unlike `testAndSaveStorageConfig`, this one does record a failure — `status = error` — because
 * there is no risk of destroying a good configuration here: the credentials are unchanged either
 * way, and a backend that has gone unreachable is exactly what this is meant to surface.
 * Credentials are decrypted only inside this function and never returned to the client.
 */
export async function retestStorageConfig(deps: Deps, organizationId: string, actorUserId: string) {
  const { prisma, env } = deps;
  const config = await prisma.storageConfig.findUnique({ where: { organizationId } });
  if (!config) {
    throw new StorageConfigError(404, "storage_not_configured", "No storage is connected yet.");
  }

  const stored = config.credentials as { enc?: string } | null;
  if (!stored?.enc) {
    throw new StorageConfigError(
      500,
      "storage_credentials_unreadable",
      "The saved storage credentials could not be read. Reconnect the backend.",
    );
  }

  const input = decryptJson<StorageConfigInput>(env, stored.enc);
  const result = await buildDriver(input).testConnection();

  await prisma.storageConfig.update({
    where: { organizationId },
    data: { status: result.success ? "verified" : "error", lastTestedAt: new Date() },
  });

  await logAuditEvent(prisma, {
    organizationId,
    actorUserId,
    action: "config_change",
    targetDescription: `Storage connection tested (${config.backendType}): ${result.success ? "passed" : "failed"}`,
  });

  if (!result.success) {
    throw new StorageConfigError(
      400,
      "storage_test_failed",
      result.message ?? "Storage connection test failed.",
    );
  }

  return { status: "verified" as const, lastTestedAt: new Date().toISOString() };
}

// Scope doc §6.1.1: "any failure stops the sequence, reports the specific reason, and does
// not save the configuration." So on failure this deliberately writes nothing — no partial
// or "error" row — the org's existing (or absent) storage config is untouched until a test
// actually passes.
export async function testAndSaveStorageConfig(
  deps: Deps,
  organizationId: string,
  actorUserId: string,
  input: StorageConfigInput,
) {
  const { prisma, env } = deps;
  const driver = buildDriver(input);
  const result = await driver.testConnection();

  if (!result.success) {
    throw new StorageConfigError(
      400,
      "storage_test_failed",
      result.message ?? "Storage connection test failed.",
    );
  }

  const credentials = { enc: encryptJson(env, input) };
  await prisma.storageConfig.upsert({
    where: { organizationId },
    create: {
      organizationId,
      backendType: input.backendType,
      credentials,
      status: "verified",
      lastTestedAt: new Date(),
    },
    update: {
      backendType: input.backendType,
      credentials,
      status: "verified",
      lastTestedAt: new Date(),
    },
  });

  await logAuditEvent(prisma, {
    organizationId,
    actorUserId,
    action: "config_change",
    targetDescription: `Storage backend configured (${input.backendType})`,
  });

  return { status: "verified" as const };
}
