import { Injectable } from '@nestjs/common';
import type { Prisma } from '@app/db';
import {
  type AuditLogResponse,
  type ListAuditLogsQuery,
  type PaginatedResponse,
} from '@app/shared';
import { PrismaService } from '../../database/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { CacheService } from '../cache/cache.service';
import { ValidationError } from '../../common/errors/domain.error';

// Reject offsets beyond this — deep paging should narrow with filters instead of
// scanning, mirroring the transactions/activity lists.
const MAX_LIST_OFFSET = 50_000;
// Cache the (filtered) row COUNT briefly so paging the audit log doesn't re-run a
// COUNT(*) over an ever-growing table on every page load — same tradeoff the
// transactions/ledger lists already make. Rows are always live; only the total
// can lag by this window.
const LIST_COUNT_CACHE_TTL_SEC = 30;

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly cache: CacheService,
  ) {}

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
    // Refresh audit-log views live. Admin-only feed; pass companyId so a
    // company's own audit panel refreshes too.
    this.realtime.admin(['audit'], entry.companyId ?? null);
  }

  async list(query: ListAuditLogsQuery): Promise<PaginatedResponse<AuditLogResponse>> {
    return this.prisma.runAsAdmin(async (tx) => {
      const where: Prisma.AuditLogWhereInput = {};
      if (query.companyId) where.companyId = query.companyId;
      if (query.entityType) where.entityType = query.entityType;
      if (query.action) where.action = query.action;

      const skip = (query.page - 1) * query.pageSize;
      if (skip > MAX_LIST_OFFSET) {
        throw new ValidationError(
          'Page too deep to scan efficiently. Narrow the results with filters (company, action, entity type).',
        );
      }
      const countKey =
        `list-count:audit:${query.companyId ?? 'all'}` +
        `:${query.entityType ?? ''}:${query.action ?? ''}`;
      const [rows, total] = await Promise.all([
        tx.auditLog.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip,
          take: query.pageSize,
          include: { actor: { select: { email: true } } },
        }),
        this.cache.wrap(countKey, LIST_COUNT_CACHE_TTL_SEC, () => tx.auditLog.count({ where })),
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
