import { z } from "zod";
import { isValidTimeZone } from "../../lib/calendar.js";

export const updateOrganizationSchema = z.object({
  name: z.string().min(1).optional(),
  industry: z.string().optional(),
  // Org-level default subfolder depth (Scope doc §7 decision 1) — a department may override
  // its own, but that's Module 2/Folders territory, not this settings screen.
  subfolderDepthLimit: z.number().int().positive().max(20).optional(),
  // The organization's calendar (SRCH-6 Upload Date filter, RET-3 auto-delete "today").
  timeZone: z
    .string()
    .refine(isValidTimeZone, { message: "Choose a valid time zone, e.g. Asia/Kolkata." })
    .optional(),
});

export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;
