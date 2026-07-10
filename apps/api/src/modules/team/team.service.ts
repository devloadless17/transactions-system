import { Injectable } from '@nestjs/common';
import argon2 from 'argon2';
import crypto from 'node:crypto';
import {
  UserRole,
  UserStatus,
  type InviteTeamMemberInput,
  type InviteTeamMemberResponse,
  type TeamMemberResponse,
  type UpdateTeamMemberInput,
} from '@app/shared';
import { PrismaService } from '../../database/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../common/errors/domain.error';

@Injectable()
export class TeamService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  async invite(companyId: string, input: InviteTeamMemberInput): Promise<InviteTeamMemberResponse> {
    const result = await this.prisma.runAsAdmin(async (tx) => {
      const existing = await tx.user.findUnique({ where: { email: input.email.toLowerCase() } });
      if (existing) throw new ConflictError(`Email '${input.email}' is already in use`);

      const tempPassword = generateTempPassword();
      const passwordHash = await argon2.hash(tempPassword, { type: argon2.argon2id });

      const member = await tx.user.create({
        data: {
          email: input.email.toLowerCase(),
          passwordHash,
          role: input.role,
          status: UserStatus.ACTIVE,
          companyId,
          mustChangePassword: true,
        },
      });
      return { member: mapMember(member), temporaryPassword: tempPassword };
    });
    this.realtime.company(companyId, ['team']);
    return result;
  }

  /**
   * Recovery: issue a fresh one-time temporary password for a company user who is
   * locked out (lost/forgotten credential). Forces a change on next login and
   * revokes every active session so the old credential is dead. The plaintext is
   * returned ONCE, to be handed to the user out-of-band.
   *
   * Callable by a platform admin (for any company) or by a COMPANY_OWNER for a
   * user in their OWN company — the caller supplies `companyId`, and the
   * `member.companyId !== companyId` check below is what makes cross-tenant
   * resets impossible. This runs under `runAsAdmin` (RLS bypassed), so that
   * check is the tenant boundary; never pass a client-supplied companyId here.
   *
   * `actorId` (owner path) blocks resetting your OWN password: rotating your own
   * credential must go through change-password, which proves knowledge of the
   * current one. Otherwise a hijacked session could mint a new credential
   * without ever knowing the old.
   */
  async resetPassword(
    companyId: string,
    id: string,
    actorId?: string,
  ): Promise<InviteTeamMemberResponse> {
    if (actorId && actorId === id) {
      throw new ForbiddenError('Use Change password to update your own password');
    }
    const result = await this.prisma.runAsAdmin(async (tx) => {
      const member = await tx.user.findUnique({ where: { id } });
      // A platform admin has companyId = NULL, so this also stops a company owner
      // from ever targeting a SUPER_ADMIN / ADMIN_OPERATOR / BACKOFFICE account.
      if (!member || member.companyId !== companyId) throw new NotFoundError('TeamMember', id);

      const tempPassword = generateTempPassword();
      const passwordHash = await argon2.hash(tempPassword, { type: argon2.argon2id });

      const updated = await tx.user.update({
        where: { id },
        data: { passwordHash, mustChangePassword: true },
      });
      // The old credential is gone — revoke every active session so it can't be used.
      await tx.refreshToken.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return { member: mapMember(updated), temporaryPassword: tempPassword };
    });
    this.realtime.company(companyId, ['team']);
    return result;
  }

  async list(companyId: string): Promise<TeamMemberResponse[]> {
    const rows = await this.prisma.runAsScoped(companyId, (tx) =>
      tx.user.findMany({ where: { companyId }, orderBy: { createdAt: 'asc' } }),
    );
    return rows.map(mapMember);
  }

  async update(
    companyId: string,
    id: string,
    actorId: string,
    input: UpdateTeamMemberInput,
  ): Promise<TeamMemberResponse> {
    const row = await this.prisma.runAsAdmin(async (tx) => {
      const member = await tx.user.findUnique({ where: { id } });
      if (!member || member.companyId !== companyId) throw new NotFoundError('TeamMember', id);
      // Protect the last active owner from being demoted/disabled.
      if (
        member.role === UserRole.COMPANY_OWNER &&
        (input.role || input.status === UserStatus.DISABLED)
      ) {
        const ownerCount = await tx.user.count({
          where: { companyId, role: UserRole.COMPANY_OWNER, status: UserStatus.ACTIVE },
        });
        const isStillOwner = (input.role ?? member.role) === UserRole.COMPANY_OWNER;
        const isStillActive = (input.status ?? member.status) === UserStatus.ACTIVE;
        if (ownerCount === 1 && (!isStillOwner || !isStillActive)) {
          throw new ValidationError('Cannot remove or demote the last active owner');
        }
      }
      if (member.id === actorId && input.status === UserStatus.DISABLED) {
        throw new ForbiddenError('Cannot disable your own account');
      }
      return tx.user.update({
        where: { id },
        data: { role: input.role ?? undefined, status: input.status ?? undefined },
      });
    });
    this.realtime.company(companyId, ['team']);
    return mapMember(row);
  }

  async remove(companyId: string, id: string, actorId: string): Promise<TeamMemberResponse> {
    // Soft remove = DISABLED. Keeps FK integrity (audit logs, etc).
    return this.update(companyId, id, actorId, { status: UserStatus.DISABLED });
  }
}

function generateTempPassword(): string {
  return crypto.randomBytes(16).toString('base64url');
}

function mapMember(row: {
  id: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  lastLoginAt: Date | null;
  createdAt: Date;
}): TeamMemberResponse {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    status: row.status,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
