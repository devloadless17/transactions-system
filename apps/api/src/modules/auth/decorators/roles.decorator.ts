import { SetMetadata } from '@nestjs/common';
import type { UserRole } from '@app/shared';

export const ROLES_KEY = 'roles';

/** Mark a route as accessible only by the listed roles. */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
