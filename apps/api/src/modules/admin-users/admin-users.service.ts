import { Injectable, Logger } from '@nestjs/common';
import argon2 from 'argon2';
import crypto from 'node:crypto';
import {
  ADMIN_ROLES,
  UserRole,
  UserStatus,
  type AdminUserResponse,
  type CreateAdminUserInput,
  type CreateAdminUserResponse,
  type ListAdminUsersQuery,
  type PaginatedResponse,
  type UpdateAdminUserInput,
} from '@app/shared';
import { PrismaService } from '../../database/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../common/errors/domain.error';
import { assertListOffset } from '../../common/pagination';
import type { Prisma } from '@app/db';

/**
 * Platform admin (SUPER_ADMIN / ADMIN_OPERATOR) management. Mirrors the
 * company-scoped team flow, but these users have no company (companyId is
 * null) and are only manageable by a SUPER_ADMIN. Until this module existed
 * platform admins could only be created by the DB seed.
 */
@Injectable()
export class AdminUsersService {
  private readonly logger = new Logger(AdminUsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  async create(input: CreateAdminUserInput, actorId: string): Promise<CreateAdminUserResponse> {
    const result = await this.prisma.runAsAdmin(async (tx) => {
      const existing = await tx.user.findUnique({ where: { email: input.email.toLowerCase() } });
      if (existing) throw new ConflictError(`Email '${input.email}' is already in use`);

      const tempPassword = generateTempPassword();
      const passwordHash = await argon2.hash(tempPassword, { type: argon2.argon2id });

      const user = await tx.user.create({
        data: {
          email: input.email.toLowerCase(),
          passwordHash,
          role: input.role,
          status: UserStatus.ACTIVE,
          companyId: null,
          mustChangePassword: true,
        },
      });

      this.logger.log(`Admin ${actorId} created platform admin ${user.email} (${user.role})`);
      return { user: mapAdminUser(user), temporaryPassword: tempPassword };
    });
    this.realtime.admin(['admin-users']);
    return result;
  }

  async list(query: ListAdminUsersQuery): Promise<PaginatedResponse<AdminUserResponse>> {
    return this.prisma.runAsAdmin(async (tx) => {
      const where: Prisma.UserWhereInput = {
        role: { in: ADMIN_ROLES as UserRole[] },
        companyId: null,
      };
      if (query.status) where.status = query.status;
      if (query.search) {
        where.email = { contains: query.search.toLowerCase() };
      }
      const skip = (query.page - 1) * query.pageSize;
      assertListOffset(skip);
      const [rows, total] = await Promise.all([
        tx.user.findMany({
          where,
          orderBy: { createdAt: 'asc' },
          skip,
          take: query.pageSize,
        }),
        tx.user.count({ where }),
      ]);
      return {
        data: rows.map(mapAdminUser),
        meta: {
          page: query.page,
          pageSize: query.pageSize,
          total,
          totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
        },
      };
    });
  }

  async update(
    id: string,
    actorId: string,
    input: UpdateAdminUserInput,
  ): Promise<AdminUserResponse> {
    const row = await this.prisma.runAsAdmin(async (tx) => {
      const target = await tx.user.findUnique({ where: { id } });
      if (!target || target.companyId !== null || !ADMIN_ROLES.includes(target.role)) {
        throw new NotFoundError('AdminUser', id);
      }

      // The SUPER_ADMIN is the system owner that runs the platform, so its
      // account can never be disabled — by anyone, including another super
      // admin. Without an active owner there'd be no one left to administer
      // the system.
      if (target.role === UserRole.SUPER_ADMIN && input.status === UserStatus.DISABLED) {
        throw new ForbiddenError('The super admin account cannot be disabled');
      }

      // Protect the last active SUPER_ADMIN from demotion too, so the platform
      // is never left without an owner. (Disabling is already rejected above.)
      if (
        target.role === UserRole.SUPER_ADMIN &&
        input.role &&
        input.role !== UserRole.SUPER_ADMIN
      ) {
        const superAdminCount = await tx.user.count({
          where: { role: UserRole.SUPER_ADMIN, status: UserStatus.ACTIVE, companyId: null },
        });
        if (superAdminCount === 1) {
          throw new ValidationError('Cannot demote the last active super admin');
        }
      }

      if (target.id === actorId && input.status === UserStatus.DISABLED) {
        throw new ForbiddenError('Cannot disable your own account');
      }

      return tx.user.update({
        where: { id },
        data: { role: input.role ?? undefined, status: input.status ?? undefined },
      });
    });
    this.realtime.admin(['admin-users']);
    return mapAdminUser(row);
  }

  async remove(id: string, actorId: string): Promise<AdminUserResponse> {
    // Soft remove = DISABLED. Keeps FK integrity (audit logs reference actor).
    return this.update(id, actorId, { status: UserStatus.DISABLED });
  }
}

function generateTempPassword(): string {
  return crypto.randomBytes(16).toString('base64url');
}

function mapAdminUser(row: {
  id: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  lastLoginAt: Date | null;
  createdAt: Date;
}): AdminUserResponse {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    status: row.status,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
