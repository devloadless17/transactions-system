import { z } from 'zod';
import { COMPANY_ROLES, UserRole, UserStatus } from '../enums';

const COMPANY_ROLE_VALUES = [
  UserRole.COMPANY_OWNER,
  UserRole.COMPANY_MANAGER,
  UserRole.COMPANY_VIEWER,
] as const;

export const inviteTeamMemberSchema = z.object({
  email: z.string().email(),
  role: z.enum(COMPANY_ROLE_VALUES),
});
export type InviteTeamMemberInput = z.infer<typeof inviteTeamMemberSchema>;

export const updateTeamMemberSchema = z.object({
  role: z.enum(COMPANY_ROLE_VALUES).optional(),
  status: z.nativeEnum(UserStatus).optional(),
});
export type UpdateTeamMemberInput = z.infer<typeof updateTeamMemberSchema>;

export const teamMemberResponseSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  role: z.nativeEnum(UserRole),
  status: z.nativeEnum(UserStatus),
  lastLoginAt: z.string().nullable(),
  createdAt: z.string(),
});
export type TeamMemberResponse = z.infer<typeof teamMemberResponseSchema>;

export const inviteTeamMemberResponseSchema = z.object({
  member: teamMemberResponseSchema,
  temporaryPassword: z.string(),
});
export type InviteTeamMemberResponse = z.infer<typeof inviteTeamMemberResponseSchema>;

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(6).max(128),
    newPassword: z.string().min(6, 'must be at least 6 characters').max(128),
  })
  .refine((v) => v.currentPassword !== v.newPassword, {
    message: 'new password must differ from current',
    path: ['newPassword'],
  });
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

// helper for FE: company roles array (re-exported for use as <select> options)
export { COMPANY_ROLES, COMPANY_ROLE_VALUES };
