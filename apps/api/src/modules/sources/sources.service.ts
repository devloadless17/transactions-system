import { Injectable } from '@nestjs/common';
import type {
  CreateSourceInput,
  PaginatedResponse,
  Pagination,
  SetSourceFeeRulesInput,
  SourceFeeRuleResponse,
  SourceResponse,
  UpdateSourceInput,
} from '@app/shared';
import { Prisma } from '@app/db';
import { PrismaService } from '../../database/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { ConflictError, NotFoundError } from '../../common/errors/domain.error';

@Injectable()
export class SourcesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  async create(input: CreateSourceInput): Promise<SourceResponse> {
    const created = await this.prisma.runAsAdmin(async (tx) => {
      const existingCode = await tx.source.findUnique({ where: { code: input.code } });
      if (existingCode) throw new ConflictError(`Source code '${input.code}' already exists`);
      const existingName = await tx.source.findUnique({ where: { name: input.name } });
      if (existingName) throw new ConflictError(`Source name '${input.name}' already exists`);
      const row = await tx.source.create({
        data: {
          name: input.name,
          code: input.code,
          metadata: (input.metadata ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        },
      });
      return mapSource(row);
    });
    this.realtime.admin(['sources']);
    return created;
  }

  async list(query: Pagination): Promise<PaginatedResponse<SourceResponse>> {
    return this.prisma.runAsAdmin(async (tx) => {
      const skip = (query.page - 1) * query.pageSize;
      const [rows, total] = await Promise.all([
        tx.source.findMany({ orderBy: { createdAt: 'desc' }, skip, take: query.pageSize }),
        tx.source.count(),
      ]);
      return {
        data: rows.map(mapSource),
        meta: {
          page: query.page,
          pageSize: query.pageSize,
          total,
          totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
        },
      };
    });
  }

  async listActiveAll(): Promise<SourceResponse[]> {
    return this.prisma.runAsAdmin(async (tx) => {
      const rows = await tx.source.findMany({
        where: { status: 'ACTIVE' },
        orderBy: { name: 'asc' },
      });
      return rows.map(mapSource);
    });
  }

  async getById(id: string): Promise<SourceResponse> {
    const row = await this.prisma.runAsAdmin((tx) => tx.source.findUnique({ where: { id } }));
    if (!row) throw new NotFoundError('Source', id);
    return mapSource(row);
  }

  async update(id: string, input: UpdateSourceInput): Promise<SourceResponse> {
    const row = await this.prisma.runAsAdmin(async (tx) => {
      const existing = await tx.source.findUnique({ where: { id } });
      if (!existing) throw new NotFoundError('Source', id);
      if (input.name && input.name !== existing.name) {
        const dupe = await tx.source.findUnique({ where: { name: input.name } });
        if (dupe) throw new ConflictError(`Source name '${input.name}' already exists`);
      }
      return tx.source.update({
        where: { id },
        data: {
          name: input.name ?? undefined,
          status: input.status ?? undefined,
          metadata:
            input.metadata === undefined
              ? undefined
              : input.metadata === null
                ? Prisma.JsonNull
                : (input.metadata as Prisma.InputJsonValue),
        },
      });
    });
    this.realtime.admin(['sources']);
    return mapSource(row);
  }

  // ---------------- source fee schedule (cost the source charges the platform) ----
  // System/admin-only: what an upstream source takes from THE PLATFORM per
  // deposit, used to compute net revenue. Never exposed to companies.

  async listFeeRules(sourceId: string): Promise<SourceFeeRuleResponse[]> {
    return this.prisma.runAsAdmin(async (tx) => {
      const source = await tx.source.findUnique({ where: { id: sourceId } });
      if (!source) throw new NotFoundError('Source', sourceId);
      const rows = await tx.sourceFeeRule.findMany({
        where: { sourceId },
        orderBy: [{ channel: 'asc' }, { minAmount: 'asc' }],
      });
      return rows.map(mapFeeRule);
    });
  }

  /** Replace a source's whole fee schedule atomically (delete-all + recreate). */
  async setFeeRules(
    sourceId: string,
    input: SetSourceFeeRulesInput,
  ): Promise<SourceFeeRuleResponse[]> {
    const result = await this.prisma.runAsAdmin(async (tx) => {
      const source = await tx.source.findUnique({ where: { id: sourceId } });
      if (!source) throw new NotFoundError('Source', sourceId);
      await tx.sourceFeeRule.deleteMany({ where: { sourceId } });
      if (input.rules.length > 0) {
        await tx.sourceFeeRule.createMany({
          data: input.rules.map((r) => ({
            sourceId,
            channel: r.channel,
            minAmount: r.minAmount,
            maxAmount: r.maxAmount,
            feeType: r.feeType,
            feeValue: r.feeValue,
            active: r.active,
          })),
        });
      }
      const rows = await tx.sourceFeeRule.findMany({
        where: { sourceId },
        orderBy: [{ channel: 'asc' }, { minAmount: 'asc' }],
      });
      return rows.map(mapFeeRule);
    });
    this.realtime.admin(['sources']);
    return result;
  }
}

function mapFeeRule(row: {
  id: string;
  sourceId: string;
  channel: SourceFeeRuleResponse['channel'];
  minAmount: { toString(): string };
  maxAmount: { toString(): string } | null;
  feeType: SourceFeeRuleResponse['feeType'];
  feeValue: { toString(): string };
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}): SourceFeeRuleResponse {
  return {
    id: row.id,
    sourceId: row.sourceId,
    channel: row.channel,
    minAmount: row.minAmount.toString(),
    maxAmount: row.maxAmount === null ? null : row.maxAmount.toString(),
    feeType: row.feeType,
    feeValue: row.feeValue.toString(),
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapSource(row: {
  id: string;
  name: string;
  code: string;
  status: SourceResponse['status'];
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
}): SourceResponse {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    status: row.status,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
