import { z } from 'zod'

/**
 * Schema for one entry in the workspaces map.
 *
 * `token` holds a Linear Personal API key. The redactor scrubs the token
 * value out of any rendered envelope; the schema treats it as an
 * opaque non-empty string so we never reveal/decode it client-side.
 *
 * `organizationId` is captured at `workspace add` time via the SDK's
 * `viewer.organization.id` query (PLAN-04 wires this in). The schema
 * reserves the column here.
 */
export const WorkspaceEntrySchema = z.object({
  name: z.string().min(1),
  token: z.string().min(1),
  organizationId: z.string().min(1),
  createdAt: z.string().datetime(),
  lastUsedAt: z.string().datetime().optional(),
})

/**
 * Top-level config shape: `{ active, workspaces }`.
 *
 * Invariant: when `active` is non-null, it MUST exist as a key in
 * `workspaces` (refine below). This catches hand-edited configs that
 * dangle the active pointer at a removed workspace.
 */
export const ConfigSchema = z
  .object({
    active: z.string().min(1).nullable(),
    workspaces: z.record(z.string(), WorkspaceEntrySchema),
  })
  .refine((c) => c.active === null || Object.hasOwn(c.workspaces, c.active), {
    message: 'active references an unregistered workspace',
    path: ['active'],
  })

export type WorkspaceEntry = z.infer<typeof WorkspaceEntrySchema>
export type Config = z.infer<typeof ConfigSchema>
