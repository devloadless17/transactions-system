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
  // Set when authenticated via a COMPANY API key (no real user row exists).
  // Services that write requestedById should pass null when this is true.
  apiKeyAuth?: true;
}

export interface AuthenticatedRequest extends Request {
  principal: AuthPrincipal;
  // Set to true by CompanyAccessGuard when the request was authenticated via a
  // company API key. CsrfGuard reads this to skip the double-submit check —
  // API keys are not susceptible to CSRF so the check is unnecessary.
  apiKeyAuth?: true;
}
