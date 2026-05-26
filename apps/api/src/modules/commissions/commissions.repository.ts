import { Injectable } from '@nestjs/common';
import type { PrismaClient } from '@app/db';
import { CacheService } from '../cache/cache.service';
import type { ResolvableRule } from './commission-resolver.service';

const RULE_CACHE_TTL_SEC = 15;

@Injectable()
export class CommissionsRepository {
  constructor(private readonly cache: CacheService) {}

  /**
   * Load the candidate rules for (companyId, sourceId): any rule whose
   * companyId is null or matches, and whose sourceId is null or matches.
   * The resolver then filters by amount range and ranks.
   *
   * Cached: this is on the hot ingestion path. The cache is invalidated
   * lazily by TTL (15s) — commission rule edits take effect within that
   * window. For immediate effect, call `invalidate()`.
   */
  async loadCandidates(
    tx: PrismaClient,
    args: { companyId: string; sourceId: string },
  ): Promise<ResolvableRule[]> {
    const key = `commission:rules:${args.companyId}:${args.sourceId}`;
    return this.cache.wrap(key, RULE_CACHE_TTL_SEC, async () => {
      const rows = await tx.commissionRule.findMany({
        where: {
          active: true,
          AND: [
            { OR: [{ companyId: null }, { companyId: args.companyId }] },
            { OR: [{ sourceId: null }, { sourceId: args.sourceId }] },
          ],
        },
        orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
      });

      return rows.map((r) => ({
        id: r.id,
        companyId: r.companyId,
        sourceId: r.sourceId,
        minAmount: r.minAmount.toString(),
        maxAmount: r.maxAmount.toString(),
        commissionType: r.commissionType,
        commissionValue: r.commissionValue.toString(),
        priority: r.priority,
        active: r.active,
        // createdAt is serialized as a string in JSON — re-hydrate so the
        // resolver's stable tie-break still works.
        createdAt:
          r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt as unknown as string),
      }));
    });
  }

  async invalidate(): Promise<void> {
    await this.cache.invalidate('commission:rules:');
  }
}
