import { z } from 'zod';
import { UserRole, UserStatus } from '../enums';

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6).max(128),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const meResponseSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  role: z.nativeEnum(UserRole),
  status: z.nativeEnum(UserStatus),
  companyId: z.string().uuid().nullable(),
  mustChangePassword: z.boolean(),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

export const csrfResponseSchema = z.object({
  csrfToken: z.string(),
});
export type CsrfResponse = z.infer<typeof csrfResponseSchema>;
