import { Injectable } from '@nestjs/common';
import { Money, commissionValueWithinBounds } from '@app/shared';
import type {
  CommissionRuleResponse,
  CreateCommissionRuleInput,
  ListCommissionRulesQuery,
  PaginatedResponse,
  UpdateCommissionRuleInput,
} from '@app/shared';
import type { Prisma } from '@app/db';
import { PrismaService } from '../../database/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { NotFoundError, ValidationError } from '../../common/errors/domain.error';
import { CommissionsRepository } from './commissions.repository';

@Injectable()
export class CommissionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: CommissionsRepository,
    private readonly realtime: RealtimeService,
  ) {}

  async create(input: CreateCommissionRuleInput): Promise<CommissionRuleResponse> {
    const row = await this.prisma.runAsAdmin(async (tx) => {
      if (input.companyId) {
        const co = await tx.company.findUnique({ where: { id: input.companyId } });
        if (!co) throw new ValidationError('companyId does not exist');
      }
      if (input.sourceId) {
        const src = await tx.source.findUnique({ where: { id: input.sourceId } });
        if (!src) throw new ValidationError('sourceId does not exist');
      }
      return tx.commissionRule.create({
        data: {
          companyId: input.companyId ?? null,
          sourceId: input.sourceId ?? null,
          operationType: input.operationType,
          feeApplication: input.feeApplication,
          minAmount: input.minAmount,
          maxAmount: input.maxAmount,
          commissionType: input.commissionType,
          commissionValue: input.commissionValue,
          priority: input.priority,
          active: input.active,
        },
      });
    });
    await this.repo.invalidate();
    this.realtime.admin(['commissions']);
    return mapRule(row);
  }

  async list(query: ListCommissionRulesQuery): Promise<PaginatedResponse<CommissionRuleResponse>> {
    return this.prisma.runAsAdmin(async (tx) => {
      const where: Prisma.CommissionRuleWhereInput = {};
      if (query.companyId !== undefined) where.companyId = query.companyId;
      if (query.sourceId !== undefined) where.sourceId = query.sourceId;
      if (query.operationType !== undefined) where.operationType = query.operationType;
      const skip = (query.page - 1) * query.pageSize;
      const [rows, total] = await Promise.all([
        tx.commissionRule.findMany({
          where,
          orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
          skip,
          take: query.pageSize,
        }),
        tx.commissionRule.count({ where }),
      ]);
      return {
        data: rows.map(mapRule),
        meta: {
          page: query.page,
          pageSize: query.pageSize,
          total,
          totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
        },
      };
    });
  }

  async update(id: string, input: UpdateCommissionRuleInput): Promise<CommissionRuleResponse> {
    const row = await this.prisma.runAsAdmin(async (tx) => {
      const existing = await tx.commissionRule.findUnique({ where: { id } });
      if (!existing) throw new NotFoundError('CommissionRule', id);
      if (input.companyId) {
        const co = await tx.company.findUnique({ where: { id: input.companyId } });
        if (!co) throw new ValidationError('companyId does not exist');
      }
      if (input.sourceId) {
        const src = await tx.source.findUnique({ where: { id: input.sourceId } });
        if (!src) throw new ValidationError('sourceId does not exist');
      }
      const minA = input.minAmount ?? existing.minAmount.toString();
      const maxA = input.maxAmount ?? existing.maxAmount.toString();
      // Decimal compare (never JS float): Number() collapses high-precision
      // 20,8 values, matching the create() guard + the schema's stated invariant.
      if (Money.of(minA).gt(Money.of(maxA))) {
        throw new ValidationError('minAmount must be <= maxAmount');
      }
      // Validate the EFFECTIVE post-merge rule, not just the patch. The create
      // schema's Zod refine only fires when BOTH commissionType and commissionValue
      // are present, so a partial PATCH (e.g. only commissionValue, or only flipping
      // the type to PERCENTAGE) could otherwise store a PERCENTAGE rule > 100% — an
      // unbounded ON_TOP overcharge. Re-check against the merged values here.
      // (Also backstopped by a DB CHECK; see migration 0023.)
      const effectiveType = input.commissionType ?? existing.commissionType;
      const effectiveValue = input.commissionValue ?? existing.commissionValue.toString();
      if (!commissionValueWithinBounds(effectiveType, effectiveValue)) {
        throw new ValidationError('PERCENTAGE commissionValue must be between 0 and 100');
      }
      return tx.commissionRule.update({
        where: { id },
        data: {
          // companyId/sourceId are nullable scope: undefined = leave as-is,
          // null = make global. `?? undefined` would lose an explicit null, so
          // distinguish "absent" from "explicit null" by checking for undefined.
          companyId: input.companyId !== undefined ? input.companyId : undefined,
          sourceId: input.sourceId !== undefined ? input.sourceId : undefined,
          operationType: input.operationType ?? undefined,
          feeApplication: input.feeApplication ?? undefined,
          minAmount: input.minAmount ?? undefined,
          maxAmount: input.maxAmount ?? undefined,
          commissionType: input.commissionType ?? undefined,
          commissionValue: input.commissionValue ?? undefined,
          priority: input.priority ?? undefined,
          active: input.active ?? undefined,
        },
      });
    });
    await this.repo.invalidate();
    this.realtime.admin(['commissions']);
    return mapRule(row);
  }

  async deactivate(id: string): Promise<CommissionRuleResponse> {
    return this.update(id, { active: false });
  }

  async remove(id: string): Promise<CommissionRuleResponse> {
    const row = await this.prisma.runAsAdmin(async (tx) => {
      const existing = await tx.commissionRule.findUnique({ where: { id } });
      if (!existing) throw new NotFoundError('CommissionRule', id);
      return tx.commissionRule.delete({ where: { id } });
    });
    await this.repo.invalidate();
    this.realtime.admin(['commissions']);
    return mapRule(row);
  }
}

function mapRule(row: {
  id: string;
  companyId: string | null;
  sourceId: string | null;
  operationType: CommissionRuleResponse['operationType'];
  feeApplication: CommissionRuleResponse['feeApplication'];
  minAmount: { toString(): string };
  maxAmount: { toString(): string };
  commissionType: CommissionRuleResponse['commissionType'];
  commissionValue: { toString(): string };
  priority: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}): CommissionRuleResponse {
  return {
    id: row.id,
    companyId: row.companyId,
    sourceId: row.sourceId,
    operationType: row.operationType,
    feeApplication: row.feeApplication,
    minAmount: row.minAmount.toString(),
    maxAmount: row.maxAmount.toString(),
    commissionType: row.commissionType,
    commissionValue: row.commissionValue.toString(),
    priority: row.priority,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
