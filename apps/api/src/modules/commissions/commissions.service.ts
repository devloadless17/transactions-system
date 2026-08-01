import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Money } from '@app/shared';
import type {
  CommissionRuleGroupResponse,
  CreateCommissionRuleGroupInput,
  FeeApplication,
  FeeOperationType,
  ListCommissionRulesQuery,
  PaginatedResponse,
  UpdateCommissionRuleGroupInput,
} from '@app/shared';
import type { Prisma, PrismaClient } from '@app/db';
import { PrismaService } from '../../database/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { NotFoundError, ValidationError } from '../../common/errors/domain.error';
import { CommissionsRepository } from './commissions.repository';

// A row as stored — the shape we regroup into a CommissionRuleGroupResponse.
type RuleRow = {
  id: string;
  groupId: string | null;
  name: string | null;
  companyId: string | null;
  sourceId: string | null;
  operationType: FeeOperationType;
  feeApplication: FeeApplication;
  minAmount: { toString(): string };
  maxAmount: { toString(): string } | null;
  commissionType: CommissionRuleGroupResponse['operations'][number]['tiers'][number]['commissionType'];
  commissionValue: { toString(): string };
  priority: number;
  active: boolean;
  createdAt: Date;
};

@Injectable()
export class CommissionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: CommissionsRepository,
    private readonly realtime: RealtimeService,
  ) {}

  /**
   * Create one logical rule: a set of operations — each with its own tier
   * ladder — applied to a set of companies (null/empty = all companies).
   * Expands to one row per company × operation × tier, all sharing a fresh
   * groupId.
   */
  async createGroup(input: CreateCommissionRuleGroupInput): Promise<CommissionRuleGroupResponse> {
    const groupId = randomUUID();
    const rows = await this.prisma.runAsAdmin(async (tx) => {
      await assertCompaniesExist(tx, input.companyIds);
      await tx.commissionRule.createMany({ data: expand(groupId, input) });
      return tx.commissionRule.findMany({ where: { groupId } });
    });
    await this.afterMutation();
    return groupRowsToResponse(groupId, rows as RuleRow[]);
  }

  async list(
    query: ListCommissionRulesQuery,
  ): Promise<PaginatedResponse<CommissionRuleGroupResponse>> {
    return this.prisma.runAsAdmin(async (tx) => {
      // Commission rules are small in number (tens of groups → low hundreds of
      // rows); load and regroup in memory, then paginate by group.
      const rows = (await tx.commissionRule.findMany({
        orderBy: [{ createdAt: 'asc' }],
        take: 5000,
      })) as RuleRow[];

      const byGroup = new Map<string, RuleRow[]>();
      for (const r of rows) {
        const gid = r.groupId ?? r.id;
        const bucket = byGroup.get(gid);
        if (bucket) bucket.push(r);
        else byGroup.set(gid, [r]);
      }

      const groups = [...byGroup.entries()].map(([gid, rs]) => groupRowsToResponse(gid, rs));
      // Highest priority first, then newest first — the order admins expect.
      groups.sort((a, b) => b.priority - a.priority || b.createdAt.localeCompare(a.createdAt));

      const total = groups.length;
      const skip = (query.page - 1) * query.pageSize;
      return {
        data: groups.slice(skip, skip + query.pageSize),
        meta: {
          page: query.page,
          pageSize: query.pageSize,
          total,
          totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
        },
      };
    });
  }

  /** Replace a group's whole spec: delete its rows and re-expand under the same id. */
  async updateGroup(
    groupId: string,
    input: UpdateCommissionRuleGroupInput,
  ): Promise<CommissionRuleGroupResponse> {
    const rows = await this.prisma.runAsAdmin(async (tx) => {
      const existing = await tx.commissionRule.count({ where: { groupId } });
      if (existing === 0) throw new NotFoundError('CommissionRuleGroup', groupId);
      await assertCompaniesExist(tx, input.companyIds);
      await tx.commissionRule.deleteMany({ where: { groupId } });
      await tx.commissionRule.createMany({ data: expand(groupId, input) });
      return tx.commissionRule.findMany({ where: { groupId } });
    });
    await this.afterMutation();
    return groupRowsToResponse(groupId, rows as RuleRow[]);
  }

  async setGroupActive(groupId: string, active: boolean): Promise<CommissionRuleGroupResponse> {
    const rows = await this.prisma.runAsAdmin(async (tx) => {
      const existing = await tx.commissionRule.count({ where: { groupId } });
      if (existing === 0) throw new NotFoundError('CommissionRuleGroup', groupId);
      await tx.commissionRule.updateMany({ where: { groupId }, data: { active } });
      return tx.commissionRule.findMany({ where: { groupId } });
    });
    await this.afterMutation();
    return groupRowsToResponse(groupId, rows as RuleRow[]);
  }

  async removeGroup(groupId: string): Promise<{ groupId: string; deleted: number }> {
    const deleted = await this.prisma.runAsAdmin(async (tx) => {
      const res = await tx.commissionRule.deleteMany({ where: { groupId } });
      if (res.count === 0) throw new NotFoundError('CommissionRuleGroup', groupId);
      return res.count;
    });
    await this.afterMutation();
    return { groupId, deleted };
  }

  private async afterMutation(): Promise<void> {
    await this.repo.invalidate();
    this.realtime.admin(['commissions']);
  }
}

/** All-or-nothing existence check for a targeted company set (skip for "all"). */
async function assertCompaniesExist(tx: PrismaClient, companyIds: string[] | null): Promise<void> {
  if (!companyIds || companyIds.length === 0) return;
  const unique = [...new Set(companyIds)];
  const found = await tx.company.findMany({ where: { id: { in: unique } }, select: { id: true } });
  if (found.length !== unique.length) {
    throw new ValidationError('one or more companyIds do not exist');
  }
}

/**
 * Expand a group spec into the per-(company × operation × tier) rows. Exported so
 * company onboarding can create a starter rule atomically in the same transaction.
 */
export function expand(
  groupId: string,
  input: CreateCommissionRuleGroupInput,
): Prisma.CommissionRuleCreateManyInput[] {
  // null/empty companyIds → a single global row (companyId null) per op/tier.
  const companies: (string | null)[] =
    input.companyIds && input.companyIds.length > 0 ? input.companyIds : [null];
  const rows: Prisma.CommissionRuleCreateManyInput[] = [];
  for (const companyId of companies) {
    for (const op of input.operations) {
      for (const tier of op.tiers) {
        rows.push({
          groupId,
          name: input.name ?? null,
          companyId,
          sourceId: null,
          operationType: op.operationType,
          // Per-operation: application AND ladder, e.g. deposits 1% DEDUCTED,
          // withdrawals 2% ON_TOP.
          feeApplication: op.feeApplication,
          minAmount: tier.minAmount,
          maxAmount: tier.maxAmount,
          commissionType: tier.commissionType,
          commissionValue: tier.commissionValue,
          priority: input.priority,
          active: input.active,
        });
      }
    }
  }
  return rows;
}

/**
 * Regroup the rows of one groupId back into the grouped response shape.
 * Exported for tests (the inverse of {@link expand}).
 */
export function groupRowsToResponse(groupId: string, rows: RuleRow[]): CommissionRuleGroupResponse {
  const first = rows[0]!;
  const hasGlobal = rows.some((r) => r.companyId === null);
  const companyIds = hasGlobal ? null : [...new Set(rows.map((r) => r.companyId as string))];

  // Bucket rows per operation (stable order by first sighting). All rows of a
  // given operation share its fee application (expand() writes it that way), so
  // the first row per operation is authoritative for it.
  const byOp = new Map<FeeOperationType, RuleRow[]>();
  for (const r of rows) {
    const bucket = byOp.get(r.operationType);
    if (bucket) bucket.push(r);
    else byOp.set(r.operationType, [r]);
  }

  // Per operation: distinct tiers (they repeat across companies), sorted
  // ascending by min; an open-ended (null max) tier sorts last.
  const operations = [...byOp.entries()].map(([operationType, opRows]) => {
    const tierMap = new Map<string, RuleRow>();
    for (const r of opRows) {
      const max = r.maxAmount === null ? '∞' : r.maxAmount.toString();
      const key = `${r.minAmount.toString()}|${max}|${r.commissionType}|${r.commissionValue.toString()}`;
      if (!tierMap.has(key)) tierMap.set(key, r);
    }
    const tiers = [...tierMap.values()]
      .sort((a, b) =>
        Money.of(a.minAmount.toString()).gt(Money.of(b.minAmount.toString())) ? 1 : -1,
      )
      .map((r) => ({
        minAmount: r.minAmount.toString(),
        maxAmount: r.maxAmount === null ? null : r.maxAmount.toString(),
        commissionType: r.commissionType,
        commissionValue: r.commissionValue.toString(),
      }));
    return { operationType, feeApplication: opRows[0]!.feeApplication, tiers };
  });

  const createdAt = rows.reduce(
    (min, r) => (r.createdAt < min ? r.createdAt : min),
    first.createdAt,
  );

  return {
    groupId,
    name: first.name ?? null,
    companyIds,
    operations,
    priority: first.priority,
    active: rows.every((r) => r.active),
    createdAt: createdAt.toISOString(),
  };
}
