import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import type { AuthenticatedRequest } from '../../../common/types/request.types';
import { ForbiddenError } from '../../../common/errors/domain.error';

/**
 * Rejects API-key (`Bearer tsk_…`) principals on dashboard-only management
 * surfaces — API-key CRUD, team management, CRM webhook config. The company
 * API-key principal carries a surrogate `COMPANY_OWNER` role (see
 * CompanyApiKeyAuthGuard) so it satisfies the `@Roles` on those handlers; without
 * this guard a LEAKED integration key could mint/rotate/revoke keys, manage
 * users, or repoint the CRM webhook (exfiltrating every event) — all of which
 * must require an interactive, CSRF-protected session.
 *
 * Place AFTER the auth guard in `@UseGuards(...)` so `req.principal` is set. A
 * session principal has `apiKeyAuth` falsy and passes through unchanged.
 */
@Injectable()
export class SessionOnlyGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    if (req.principal?.apiKeyAuth) {
      throw new ForbiddenError('This endpoint requires a dashboard session, not an API key');
    }
    return true;
  }
}
