import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  FRONTEND_URL: z.string().default("http://localhost:5173"),

  // Storage credentials (StorageConfig.credentials) are encrypted at rest with this key —
  // 32 random bytes, base64-encoded. Rotating it invalidates every saved storage config.
  STORAGE_CREDENTIALS_KEY: z.string().min(1, "STORAGE_CREDENTIALS_KEY is required"),

  JWT_ACCESS_SECRET: z.string().min(1, "JWT_ACCESS_SECRET is required"),
  JWT_ACCESS_EXPIRES_IN: z.string().default("15m"),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  EMAIL_VERIFICATION_TTL_HOURS: z.coerce.number().int().positive().default(24),
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().positive().default(60),
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().positive().default(15),

  // Upload & OCR (Module 6).
  // 120MB — a margin above the 100MB target (UPL-7). Files over this are rejected with a clear
  // message before any bytes are stored.
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(125829120),
  // PDF page ceiling for OCR — an oversized scan is skipped rather than allowed to stall the queue.
  OCR_MAX_PAGES: z.coerce.number().int().positive().default(50),

  // Email — if BREVO_API_KEY is unset, mail is logged to the console instead of sent.
  BREVO_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default("noreply@abateas.app"),
  EMAIL_FROM_NAME: z.string().default("DMS"),
  // Suppress all outbound mail (test runs) — belt-and-braces alongside the console fallback, so a
  // real BREVO_API_KEY in .env doesn't send during automated tests.
  MAIL_DISABLED: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  return parsed.data;
}
