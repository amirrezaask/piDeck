import { z } from 'zod';

import { IdSchema, IsoTimestampSchema, PaginationQuerySchema } from './common';

export const CreateManagedProjectRequestSchema = z.object({
  name: z.string().trim().min(1).max(256).optional(),
  path: z.string().trim().min(1).max(4096),
});
export type CreateManagedProjectRequest = z.infer<typeof CreateManagedProjectRequestSchema>;

export const UpdateManagedProjectRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(256).optional(),
    path: z.string().trim().min(1).max(4096).optional(),
  })
  .refine((request) => request.name !== undefined || request.path !== undefined, {
    message: 'At least one project field must be provided',
  });
export type UpdateManagedProjectRequest = z.infer<typeof UpdateManagedProjectRequestSchema>;

export const ManagedProjectResponseSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(256),
  path: z.string().min(1),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  lastUsedAt: IsoTimestampSchema,
});
export type ManagedProjectResponse = z.infer<typeof ManagedProjectResponseSchema>;

export const ManagedProjectListQuerySchema = PaginationQuerySchema.strict();
export type ManagedProjectListQuery = z.infer<typeof ManagedProjectListQuerySchema>;

export const ManagedProjectListResponseSchema = z.object({
  projects: z.array(ManagedProjectResponseSchema),
  nextCursor: z.string().nullable(),
});
export type ManagedProjectListResponse = z.infer<typeof ManagedProjectListResponseSchema>;
