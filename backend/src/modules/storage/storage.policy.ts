import { promises as fs } from "node:fs";
import path from "node:path";
import type { Env } from "../../config/env.js";
import type { StorageConfigInput } from "./storage.schemas.js";

/**
 * Where a storage backend may point (SECURITY_AUDIT.md M-4). Without this, the storage settings were
 * a server-side primitive: a NAS `mountPath` could be any directory on the API host (the connection
 * test writes, reads and deletes a file there, and its error text tells existing paths from missing
 * ones), and an R2 `endpoint` could be any URL, so the server would send signed requests to internal
 * services or a cloud metadata address and report what happened.
 *
 * Checked when a config is saved or re-tested, AND every time the live driver is built, so a config
 * saved before this rule, or written straight into the database, can't be used either.
 */
export class StorageTargetError extends Error {
  constructor(
    public code: "storage_path_not_allowed" | "storage_endpoint_not_allowed" | "nas_root_not_configured",
    message: string,
  ) {
    super(message);
  }
}

/** True when `child` is `parent` itself or somewhere beneath it. Both must be absolute. */
export function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function assertNasPathAllowed(env: Env, mountPath: string) {
  const root = env.STORAGE_NAS_ROOT;
  if (!root) {
    if (env.NODE_ENV === "production") {
      throw new StorageTargetError(
        "nas_root_not_configured",
        "NAS storage isn't enabled on this server. The administrator must set STORAGE_NAS_ROOT to the directory where the share is mounted.",
      );
    }
    return; // development / test: any path (the check scripts use OS temp directories)
  }
  if (!path.isAbsolute(mountPath)) {
    throw new StorageTargetError("storage_path_not_allowed", "The mount path must be an absolute path.");
  }
  // realpath follows symlinks, so a link inside the root pointing elsewhere is judged by its target.
  let realRoot: string;
  let realMount: string;
  try {
    [realRoot, realMount] = await Promise.all([fs.realpath(root), fs.realpath(mountPath)]);
  } catch {
    // Same answer whether the path is missing or outside: no existence oracle beyond the root.
    throw new StorageTargetError("storage_path_not_allowed", `The mount path must be an existing folder inside ${root}.`);
  }
  if (!isWithin(realRoot, realMount)) {
    throw new StorageTargetError("storage_path_not_allowed", `The mount path must be an existing folder inside ${root}.`);
  }
}

const R2_HOST = /^[a-z0-9]{32}(\.[a-z]{2,10})?\.r2\.cloudflarestorage\.com$/;

function assertR2EndpointAllowed(env: Env, endpoint: string) {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new StorageTargetError("storage_endpoint_not_allowed", "The endpoint isn't a valid URL.");
  }
  const host = url.hostname.toLowerCase();
  const allowedHost = R2_HOST.test(host) || env.STORAGE_R2_ALLOWED_HOSTS.includes(host);
  const clean =
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    (url.port === "" || url.port === "443") &&
    (url.pathname === "/" || url.pathname === "") &&
    url.search === "" &&
    url.hash === "";
  if (!allowedHost || !clean) {
    throw new StorageTargetError(
      "storage_endpoint_not_allowed",
      "The endpoint must be your Cloudflare R2 address: https://<account-id>.r2.cloudflarestorage.com",
    );
  }
}

export async function assertStorageTargetAllowed(env: Env, input: StorageConfigInput): Promise<void> {
  if (input.backendType === "nas") await assertNasPathAllowed(env, input.mountPath);
  else assertR2EndpointAllowed(env, input.endpoint);
}
