import { z } from 'zod';
import { SourceStatus } from '../enums';

const codeRegex = /^[a-z][a-z0-9_]{1,49}$/;

export const createSourceSchema = z.object({
  name: z.string().trim().min(2).max(120),
  code: z.string().trim().toLowerCase().regex(codeRegex, 'code must be 2-50 chars, [a-z0-9_]'),
  metadata: z.record(z.unknown()).optional(),
});
export type CreateSourceInput = z.infer<typeof createSourceSchema>;

export const updateSourceSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  status: z.nativeEnum(SourceStatus).optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
});
export type UpdateSourceInput = z.infer<typeof updateSourceSchema>;

export const sourceResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  code: z.string(),
  status: z.nativeEnum(SourceStatus),
  metadata: z.record(z.unknown()).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SourceResponse = z.infer<typeof sourceResponseSchema>;
