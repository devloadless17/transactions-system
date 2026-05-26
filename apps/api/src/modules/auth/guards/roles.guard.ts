import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { UserRole } from '@app/shared';
import { ForbiddenError } from '../../../common/errors/domain.error';
import type { AuthenticatedRequest } from '../../../common/types/request.types';
import { ROLES_KEY } from '../decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const { principal } = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!principal) throw new ForbiddenError();
    if (!required.includes(principal.role)) {
      throw new ForbiddenError(`Role ${principal.role} is not allowed for this resource`);
    }
    return true;
  }
}
