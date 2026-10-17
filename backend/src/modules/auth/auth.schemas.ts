import { z } from "zod";

export const registerSchema = z.object({
  fullName: z.string().min(1).max(200),
  email: z.string().email().toLowerCase(),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export const loginSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(1),
});

export const createOrganizationSchema = z.object({
  name: z.string().min(1).max(200),
  industry: z.string().max(200).optional(),
  inviteCode: z.string().optional(),
});

export const selectOrganizationSchema = z.object({
  organizationId: z.string().uuid(),
});

export const refreshSchema = z.object({
  organizationId: z.string().uuid().optional(),
});

export const verifyEmailSchema = z.object({
  token: z.string().min(1),
});

export const forgotPasswordSchema = z.object({
  email: z.string().email().toLowerCase(),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(8, "Password must be at least 8 characters"),
});
