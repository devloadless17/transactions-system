import { Injectable } from '@nestjs/common';
import type { CompanySourceResponse, SetCompanySourceInput } from '@app/shared';
import { PrismaService } from '../../database/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { NotFoundError } from '../../common/errors/domain.error';

/**
 * Admin management of company↔source opt-ins. A SOURCE API key may only ingest
 * for companies enabled here (enforced in TransactionsService.ingest).
 */
@Injectable()
export class CompanySourcesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  async listForSource(sourceId: string): Promise<CompanySourceResponse[]> {
    const rows = await this.prisma.runAsAdmin((tx) =>
      tx.companySource.findMany({
        where: { sourceId },
        orderBy: { createdAt: 'desc' },
        include: { company: { select: { name: true, slug: true } } },
      }),
    );
    return rows.map(mapRow);
  }

  /** Enable (or disable) a company for a source. Upsert by the (company, source) pair. */
  async set(sourceId: string, input: SetCompanySourceInput): Promise<CompanySourceResponse> {
    const row = await this.prisma.runAsAdmin(async (tx) => {
      const company = await tx.company.findUnique({
        where: { id: input.companyId },
        select: { id: true },
      });
      if (!company) throw new NotFoundError('Company', input.companyId);
      return tx.companySource.upsert({
        where: { companyId_sourceId: { companyId: input.companyId, sourceId } },
        update: { enabled: input.enabled },
        create: { companyId: input.companyId, sourceId, enabled: input.enabled },
        include: { company: { select: { name: true, slug: true } } },
      });
    });
    this.realtime.admin(['sources'], input.companyId);
    return mapRow(row);
  }

  async remove(sourceId: string, companyId: string): Promise<void> {
    await this.prisma.runAsAdmin((tx) =>
      tx.companySource.deleteMany({ where: { sourceId, companyId } }),
    );
    this.realtime.admin(['sources'], companyId);
  }
}

function mapRow(row: {
  id: string;
  companyId: string;
  sourceId: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  company?: { name: string; slug: string } | null;
}): CompanySourceResponse {
  return {
    id: row.id,
    companyId: row.companyId,
    companyName: row.company?.name ?? null,
    companySlug: row.company?.slug ?? null,
    sourceId: row.sourceId,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
