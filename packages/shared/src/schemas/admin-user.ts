import { z } from 'zod';
import { UserRole, UserStatus } from '../enums';
import { paginationSchema } from './common';

// Platform admins only — company roles are managed via the team endpoints.
// BACKOFFICE is a platform admin too, so a super admin can create/assign it here.
const ADMIN_ROLE_VALUES = [
  UserRole.SUPER_ADMIN,
  UserRole.ADMIN_OPERATOR,
  UserRole.BACKOFFICE,
] as const;

export const createAdminUserSchema = z.object({
  email: z.string().email(),
  role: z.enum(ADMIN_ROLE_VALUES),
});
export type CreateAdminUserInput = z.infer<typeof createAdminUserSchema>;

export const updateAdminUserSchema = z.object({
  role: z.enum(ADMIN_ROLE_VALUES).optional(),
  status: z.nativeEnum(UserStatus).optional(),
});
export type UpdateAdminUserInput = z.infer<typeof updateAdminUserSchema>;

export const listAdminUsersQuerySchema = paginationSchema.extend({
  status: z.nativeEnum(UserStatus).optional(),
  search: z.string().trim().min(1).max(120).optional(),
});
export type ListAdminUsersQuery = z.infer<typeof listAdminUsersQuerySchema>;

export const adminUserResponseSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  role: z.nativeEnum(UserRole),
  status: z.nativeEnum(UserStatus),
  lastLoginAt: z.string().nullable(),
  createdAt: z.string(),
});
export type AdminUserResponse = z.infer<typeof adminUserResponseSchema>;

export const createAdminUserResponseSchema = z.object({
  user: adminUserResponseSchema,
  // Plaintext temp password — shown only once at creation.
  temporaryPassword: z.string(),
});
export type CreateAdminUserResponse = z.infer<typeof createAdminUserResponseSchema>;

export { ADMIN_ROLE_VALUES };
