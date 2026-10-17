import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { StorageDriver, TestConnectionResult } from "./types.js";

export interface NasConfig {
  mountPath: string;
  // Captured at setup for the ops runbook (Scope doc lists "credentials (SMB/NFS)" as an
  // input) but not used by this driver — see the design-decision note below.
  username?: string;
  password?: string;
}

/**
 * Design decision (flagged in each_update.md rather than guessed silently): the Scope doc
 * doesn't specify *how* the app authenticates to an SMB/NFS share. Standing up a real SMB/NFS
 * client session from Node is heavy (OS-specific, needs root to mount) and orthogonal to what
 * this module actually needs to guarantee — a working read/write/delete round trip. This driver
 * treats `mountPath` as an already-mounted filesystem path: the ops team mounts the share at the
 * OS/container level (the standard pattern for on-prem NAS deployments), and the app just does
 * plain fs operations against that path. If a deployment later needs the app itself to establish
 * the SMB session, that's a driver swap behind this same interface — not a rewrite.
 */
export class NasDriver implements StorageDriver {
  constructor(private config: NasConfig) {}

  async testConnection(): Promise<TestConnectionResult> {
    const testKey = `.dms-test-${randomUUID()}.tmp`;
    const testPath = path.join(this.config.mountPath, testKey);
    const testContent = Buffer.from(`dms-storage-test-${Date.now()}`);

    try {
      await fs.access(this.config.mountPath);
    } catch (err) {
      return { success: false, step: "connect", message: mapFsError(err, "connect") };
    }

    try {
      await fs.writeFile(testPath, testContent);
    } catch (err) {
      return { success: false, step: "write", message: mapFsError(err, "write") };
    }

    try {
      const readBack = await fs.readFile(testPath);
      if (!readBack.equals(testContent)) {
        await fs.unlink(testPath).catch(() => {});
        return {
          success: false,
          step: "read",
          message: "Wrote the test file but read back different contents — check share consistency.",
        };
      }
    } catch (err) {
      return { success: false, step: "read", message: mapFsError(err, "read") };
    }

    try {
      await fs.unlink(testPath);
    } catch (err) {
      return { success: false, step: "delete", message: mapFsError(err, "delete") };
    }

    return { success: true };
  }

  async put(key: string, data: Buffer): Promise<string> {
    const target = path.join(this.config.mountPath, key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data);
    return key; // storage_ref — opaque, backend-agnostic
  }

  async get(storageRef: string): Promise<Buffer> {
    return fs.readFile(path.join(this.config.mountPath, storageRef));
  }

  async delete(storageRef: string): Promise<void> {
    await fs.unlink(path.join(this.config.mountPath, storageRef));
  }
}

function mapFsError(err: unknown, step: "connect" | "write" | "read" | "delete"): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  switch (code) {
    case "ENOENT":
      return step === "connect"
        ? "Mount path not found — check the path and that the share is mounted."
        : "Path disappeared during the test — check the share is still mounted.";
    case "ENOTDIR":
      return "Mount path is not a directory — check the configured path.";
    case "EACCES":
    case "EPERM":
      return step === "delete"
        ? "Credentials can write but not delete — check permissions."
        : "No write permission on this path — check share permissions.";
    case "ENOSPC":
      return "Disk full — no space left on the share.";
    case "EBUSY":
      return "The share is busy or locked — try again.";
    default:
      return "Couldn't reach the storage endpoint — check the address and network.";
  }
}
