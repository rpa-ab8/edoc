import {
  S3Client,
  HeadBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import type { StorageDriver, TestConnectionResult } from "./types.js";

export interface R2Config {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

// Cloudflare R2 is S3-compatible, so the AWS SDK v3 S3 client works unmodified against it —
// just pointed at R2's endpoint with region "auto" (Tech Stack doc §3.4/§3.9).
export class R2Driver implements StorageDriver {
  private client: S3Client;

  constructor(private config: R2Config) {
    this.client = new S3Client({
      region: "auto",
      endpoint: config.endpoint,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      // AWS SDK v3 (>=3.729 or so) defaults to computing a flexible checksum on every
      // request and validating one on every response. R2 doesn't support that the same way
      // S3 does, so the checksum header breaks SigV4 signing and R2 rejects the request —
      // which surfaces as SignatureDoesNotMatch/403 and gets misread as bad credentials even
      // when the access key and secret are correct. Restoring the pre-checksum-era behavior
      // (only compute/validate when the operation actually requires it) fixes that.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }

  async testConnection(): Promise<TestConnectionResult> {
    const testKey = `.dms-test-${randomUUID()}.tmp`;
    const testContent = Buffer.from(`dms-storage-test-${Date.now()}`);

    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.config.bucket }));
    } catch (err) {
      return { success: false, step: "connect", message: mapS3Error(err) };
    }

    try {
      await this.client.send(
        new PutObjectCommand({ Bucket: this.config.bucket, Key: testKey, Body: testContent }),
      );
    } catch (err) {
      return { success: false, step: "write", message: mapS3Error(err) };
    }

    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: testKey }),
      );
      const body = await result.Body?.transformToByteArray();
      if (!body || !Buffer.from(body).equals(testContent)) {
        await this.client
          .send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: testKey }))
          .catch(() => {});
        return {
          success: false,
          step: "read",
          message: "Wrote the test object but read back different contents.",
        };
      }
    } catch (err) {
      return { success: false, step: "read", message: mapS3Error(err) };
    }

    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: testKey }));
    } catch (err) {
      return { success: false, step: "delete", message: mapS3Error(err) };
    }

    return { success: true };
  }

  async put(key: string, data: Buffer, contentType?: string): Promise<string> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: data,
        ContentType: contentType,
      }),
    );
    return key;
  }

  async get(storageRef: string): Promise<Buffer> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.config.bucket, Key: storageRef }),
    );
    const body = await result.Body?.transformToByteArray();
    return Buffer.from(body ?? new Uint8Array());
  }

  async delete(storageRef: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: storageRef }));
  }
}

function mapS3Error(err: unknown): string {
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number }; code?: string };
  // The message returned to the client is deliberately generic (Scope doc §6.1.1's mapped
  // messages) — log the real error server-side so a genuine misdiagnosis (like the checksum
  // issue above) is debuggable from the backend console instead of guessed at again.
  console.error("[storage/r2] connection test error:", err);
  const httpStatus = e?.$metadata?.httpStatusCode;

  if (e?.name === "NoSuchBucket" || httpStatus === 404) {
    return "Bucket does not exist or isn't reachable.";
  }
  if (e?.name === "InvalidAccessKeyId" || e?.name === "SignatureDoesNotMatch" || httpStatus === 403) {
    return "Access key or secret is incorrect.";
  }
  if (e?.name === "AccessDenied") {
    return "Credentials can write but not delete — check permissions.";
  }
  if (e?.name === "TimeoutError" || e?.name === "NetworkingError" || e?.code === "ENOTFOUND") {
    return "Couldn't reach the storage endpoint — check the address and network.";
  }
  return "Couldn't reach the storage endpoint — check the address and network.";
}
