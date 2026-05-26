import type { UserRole } from '@app/shared';

export interface AccessTokenPayload {
  sub: string;
  email: string;
  role: UserRole;
  companyId: string | null;
}

export interface RefreshTokenPayload {
  sub: string;
  jti: string;
}
