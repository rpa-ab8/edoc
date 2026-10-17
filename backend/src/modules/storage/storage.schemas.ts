import { z } from "zod";

export const nasConnectionSchema = z.object({
  backendType: z.literal("nas"),
  mountPath: z.string().min(1, "Mount path is required"),
  username: z.string().optional(),
  password: z.string().optional(),
});

export const r2ConnectionSchema = z.object({
  backendType: z.literal("r2"),
  endpoint: z.string().url("Must be a valid URL"),
  bucket: z.string().min(1, "Bucket is required"),
  accessKeyId: z.string().min(1, "Access key is required"),
  secretAccessKey: z.string().min(1, "Secret key is required"),
});

export const storageConfigSchema = z.discriminatedUnion("backendType", [
  nasConnectionSchema,
  r2ConnectionSchema,
]);

export type StorageConfigInput = z.infer<typeof storageConfigSchema>;
