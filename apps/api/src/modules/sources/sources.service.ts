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
import { Money, SourceFeeChannel } from '@app/shared';
import { PrismaService } from '../../database/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { CacheService } from '../cache/cache.service';
import { computeSourceFee, type SourceFeeRuleRow } from './source-fee.compute';
import { ConflictError, NotFoundError } from '../../common/errors/domain.error';
import { assertListOffset } from '../../common/pagination';

@Injectable()
export class SourcesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly cache: CacheService,
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
      assertListOffset(skip);
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

  /**
   * Active source catalog for ANY authenticated user (incl. company tenants),
   * who need name/code/status to interpret their transactions. The admin-set
   * `metadata` blob is internal config and is deliberately NOT selected or
   * returned here — only the paginated admin `list`/`getById` (admin-gated)
   * expose it. Keep this metadata-free: it is the one source read companies can
   * reach.
   */
  async listActiveAll(): Promise<SourceResponse[]> {
    return this.prisma.runAsAdmin(async (tx) => {
      const rows = await tx.source.findMany({
        where: { status: 'ACTIVE' },
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          code: true,
          status: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      return rows.map((row) => ({ ...mapSource({ ...row, metadata: null }), metadata: null }));
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
    // The fee schedule just changed — bust the (source, channel) rule cache the
    // ingest path reads from so NEW deposits price against the updated schedule
    // immediately instead of waiting out the short TTL.
    await this.cache.invalidate('sourcefee:rules:');
    // Apply the saved schedule to this source's EXISTING deposits too — the
    // per-deposit source fee is frozen at settlement, so without this a newly
    // configured (or edited) schedule would only affect future deposits and leave
    // historical ones at their old/zero value. Done POST-COMMIT in batches (see
    // repriceExistingDeposits) so the schedule save itself commits fast and can't
    // hold a long lock / hit the 5s tx limit on a high-volume source.
    await this.repriceExistingDeposits(sourceId);
    // Net revenue and the source-fee breakdown on the admin platform overview
    // derive from the (now-repriced) source_fee_amount column, so bust the
    // analytics cache and refresh the analytics surface too — not just 'sources'.
    // All admin-only; companies never receive these events or figures.
    await this.cache.invalidate('analytics:');
    this.realtime.admin(['sources', 'analytics']);
    return result;
  }

  /**
   * Re-price a source's already-settled (COMPLETED) deposits against its CURRENT
   * schedule. The per-deposit source fee is frozen at settlement, so a schedule
   * configured/edited afterwards wouldn't otherwise reach historical deposits.
   *
   * Runs in keyset-paginated batches, each in its OWN short admin transaction, so
   * a source with millions of deposits can neither blow the 5s interactive-tx
   * limit nor hold a long lock on the hot `transactions` table. Uses the shared
   * `computeSourceFee` (ROUND_HALF_EVEN) — the SAME function and rounding ingest
   * froze with — so reprice, settlement and the out-of-band backfill script all
   * agree. Idempotent (it overwrites the frozen value) and resumable (a failed
   * batch can simply be re-run). Channel is classified per deposit by the
   * whish_payments link, identical to settlement.
   */
  private async repriceExistingDeposits(sourceId: string): Promise<void> {
    const rules = await this.prisma.runAsAdmin((tx) =>
      tx.sourceFeeRule.findMany({ where: { sourceId, active: true } }),
    );
    const ruleRows: SourceFeeRuleRow[] = rules.map((r) => ({
      channel: r.channel,
      minAmount: r.minAmount,
      maxAmount: r.maxAmount,
      feeType: r.feeType,
      feeValue: r.feeValue,
      active: r.active,
    }));

    // Keyset cursor over the uuid PK. Start at the zero-uuid (sorts before any
    // real id) and cast the bound value so Postgres compares uuid-to-uuid.
    let cursor = '00000000-0000-0000-0000-000000000000';
    for (;;) {
      const processed = await this.prisma.runAsAdmin(async (tx) => {
        const batch = await tx.$queryRawUnsafe<
          Array<{ id: string; amount: string; is_whish: boolean }>
        >(
          `SELECT t.id, t.amount::text AS amount,
                  EXISTS (SELECT 1 FROM whish_payments wp WHERE wp.transaction_id = t.id) AS is_whish
           FROM transactions t
           WHERE t.source_id = $1::uuid AND t.status = 'COMPLETED' AND t.id > $2::uuid
           ORDER BY t.id ASC
           LIMIT $3`,
          sourceId,
          cursor,
          REPRICE_BATCH_SIZE,
        );
        if (batch.length === 0) return 0;
        // Group the batch by computed fee so each distinct value is a single
        // updateMany, not one UPDATE per row.
        const idsByFee = new Map<string, string[]>();
        for (const row of batch) {
          const channel = row.is_whish ? SourceFeeChannel.WHISH_PAY : SourceFeeChannel.INGEST;
          const fee = computeSourceFee(ruleRows, channel, Money.of(row.amount)).toString();
          const ids = idsByFee.get(fee);
          if (ids) ids.push(row.id);
          else idsByFee.set(fee, [row.id]);
        }
        for (const [fee, ids] of idsByFee) {
          await tx.transaction.updateMany({
            where: { id: { in: ids } },
            data: { sourceFeeAmount: fee },
          });
        }
        cursor = batch[batch.length - 1]!.id;
        return batch.length;
      });
      if (processed < REPRICE_BATCH_SIZE) break;
    }
  }
}

// Batch size for the post-commit retroactive reprice. Small enough that each
// batch's transaction stays well under the interactive-tx timeout and holds row
// locks only briefly; large enough to keep round-trips low.
const REPRICE_BATCH_SIZE = 1000;

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
