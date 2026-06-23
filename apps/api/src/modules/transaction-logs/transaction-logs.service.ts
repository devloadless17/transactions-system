import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@app/db';
import type {
  ListTransactionLogsQuery,
  PaginatedResponse,
  TransactionLogKind,
  TransactionLogResponse,
} from '@app/shared';
import { PrismaService } from '../../database/prisma.service';
import { assertListOffset } from '../../common/pagination';

export interface TransactionLogEntry {
  kind: TransactionLogKind;
  companyId?: string | null;
  sourceCode?: string | null;
  /** externalTransactionId (INGEST) or the Whish externalId (WHISH_LINK). */
  reference?: string | null;
  transactionId?: string | null;
  statusCode: number;
  success: boolean;
  request?: unknown;
  response?: unknown;
}

/**
 * Super-admin request/response log for the two transaction entry points
 * (Whish link generation + source ingest). Writes are best-effort and admin-
 * scoped (RLS allows only app.bypass_rls, i.e. runAsAdmin).
 */
@Injectable()
export class TransactionLogsService {
  private readonly logger = new Logger(TransactionLogsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Fire-and-forget. Logging must NEVER break the transaction path, so this
   * swallows its own errors — callers don't await it.
   */
  record(entry: TransactionLogEntry): void {
    void this.prisma
      .runAsAdmin((tx) =>
        tx.transactionLog.create({
          data: {
            kind: entry.kind,
            companyId: entry.companyId ?? null,
            sourceCode: entry.sourceCode ?? null,
            reference: entry.reference ?? null,
            transactionId: entry.transactionId ?? null,
            statusCode: entry.statusCode,
            success: entry.success,
            request: (entry.request ?? null) as Prisma.InputJsonValue,
            response: (entry.response ?? null) as Prisma.InputJsonValue,
          },
        }),
      )
      .catch((err) => this.logger.warn(`transaction log write failed: ${(err as Error).message}`));
  }

  async list(query: ListTransactionLogsQuery): Promise<PaginatedResponse<TransactionLogResponse>> {
    return this.prisma.runAsAdmin(async (tx) => {
      const where: Prisma.TransactionLogWhereInput = {};
      if (query.kind) where.kind = query.kind;
      if (query.companyId) where.companyId = query.companyId;
      if (query.success !== undefined) where.success = query.success === 'true';
      if (query.search) where.reference = { contains: query.search, mode: 'insensitive' };

      const skip = (query.page - 1) * query.pageSize;
      assertListOffset(skip);
      const [rows, total] = await Promise.all([
        tx.transactionLog.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip,
          take: query.pageSize,
        }),
        tx.transactionLog.count({ where }),
      ]);
      return {
        data: rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          companyId: r.companyId,
          sourceCode: r.sourceCode,
          reference: r.reference,
          transactionId: r.transactionId,
          statusCode: r.statusCode,
          success: r.success,
          request: r.request ?? null,
          response: r.response ?? null,
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
