import { z } from "zod";

export const updateOrganizationSchema = z.object({
  name: z.string().min(1).optional(),
  industry: z.string().optional(),
  // Org-level default subfolder depth (Scope doc §7 decision 1) — a department may override
  // its own, but that's Module 2/Folders territory, not this settings screen.
  subfolderDepthLimit: z.number().int().positive().max(20).optional(),
});

export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;
