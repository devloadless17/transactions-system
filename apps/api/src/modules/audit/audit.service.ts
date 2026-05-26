import { Injectable } from '@nestjs/common';
import type { Prisma } from '@app/db';
import {
  type AuditLogResponse,
  type ListAuditLogsQuery,
  type PaginatedResponse,
} from '@app/shared';
import { PrismaService } from '../../database/prisma.service';

export interface AuditEntry {
  actorId?: string | null;
  companyId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.prisma.runAsAdmin((tx) =>
      tx.auditLog.create({
        data: {
          actorId: entry.actorId ?? null,
          companyId: entry.companyId ?? null,
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId ?? null,
          metadata: (entry.metadata ?? null) as Prisma.InputJsonValue,
          ipAddress: entry.ipAddress ?? null,
          userAgent: entry.userAgent ?? null,
        },
      }),
    );
  }

  async list(query: ListAuditLogsQuery): Promise<PaginatedResponse<AuditLogResponse>> {
    return this.prisma.runAsAdmin(async (tx) => {
      const where: Prisma.AuditLogWhereInput = {};
      if (query.companyId) where.companyId = query.companyId;
      if (query.entityType) where.entityType = query.entityType;
      if (query.action) where.action = query.action;

      const skip = (query.page - 1) * query.pageSize;
      const [rows, total] = await Promise.all([
        tx.auditLog.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip,
          take: query.pageSize,
          include: { actor: { select: { email: true } } },
        }),
        tx.auditLog.count({ where }),
      ]);
      return {
        data: rows.map((r) => ({
          id: r.id,
          actorId: r.actorId,
          actorEmail: r.actor?.email ?? null,
          companyId: r.companyId,
          action: r.action,
          entityType: r.entityType,
          entityId: r.entityId,
          metadata: (r.metadata as Record<string, unknown> | null) ?? null,
          ipAddress: r.ipAddress,
          createdAt: r.createdAt.toISOString(),
        })),
        meta: {
          page: query.page,
          pageSize: query.pageSize,
          total,
          totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
        },
      };
    });
  }
}
