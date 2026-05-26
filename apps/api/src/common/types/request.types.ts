import type { Request } from 'express';
import type { UserRole } from '@app/shared';

export interface AuthPrincipal {
  userId: string;
  email: string;
  role: UserRole;
  companyId: string | null;
  // Set only when the principal was authenticated via a SOURCE API key.
  // Source keys post on behalf of an external provider (OMT, wish, ...).
  sourceId?: string | null;
}

export interface AuthenticatedRequest extends Request {
  principal: AuthPrincipal;
}
