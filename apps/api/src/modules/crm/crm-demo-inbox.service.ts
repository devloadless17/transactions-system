import { Injectable, Logger } from '@nestjs/common';
import type { CrmDemoEvent, Prisma } from '@app/db';
import type {
  CrmDemoEventResponse,
  CrmEventPayload,
  CrmEventType,
  CrmTransactionStatus,
} from '@app/shared';
import { PrismaService } from '../../database/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';

// Keep the preview feed small — it's a demonstration, not an archive.
const MAX_INBOX_ROWS = 50;

/**
 * Backs the built-in "mock CRM" preview. `receive` stores the exact event we
 * POST to a company's CRM, upserted by `reference` so one logical transaction
 * visibly transitions PENDING → COMPLETED (and FAILED/EXPIRED/REVERSED). This
 * is the same capture the public demo endpoint uses, so what the company sees
 * here is byte-identical to what their real CRM would receive.
 */
@Injectable()
export class CrmDemoInboxService {
  private readonly logger = new Logger(CrmDemoInboxService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  async receive(companyId: string, payload: CrmEventPayload): Promise<void> {
    await this.prisma.runAsAdmin((tx) =>
      tx.crmDemoEvent.upsert({
        where: { companyId_reference: { companyId, reference: payload.reference } },
        create: {
          companyId,
          reference: payload.reference,
          eventType: payload.event,
          status: payload.transaction.status,
          payload: payload as unknown as Prisma.InputJsonValue,
        },
        update: {
          eventType: payload.event,
          status: payload.transaction.status,
          payload: payload as unknown as Prisma.InputJsonValue,
          receivedAt: new Date(),
        },
      }),
    );
    await this.prune(companyId);
    this.realtime.company(companyId, ['crm']);
  }

  async list(companyId: string): Promise<CrmDemoEventResponse[]> {
    const rows = await this.prisma.runAsTenant(companyId, (tx) =>
      tx.crmDemoEvent.findMany({
        where: { companyId },
        orderBy: { receivedAt: 'desc' },
        take: MAX_INBOX_ROWS,
      }),
    );
    return rows.map(mapDemoEvent);
  }

  private async prune(companyId: string): Promise<void> {
    const stale = await this.prisma.runAsAdmin((tx) =>
      tx.crmDemoEvent.findMany({
        where: { companyId },
        orderBy: { receivedAt: 'desc' },
        skip: MAX_INBOX_ROWS,
        select: { id: true },
      }),
    );
    if (stale.length === 0) return;
    await this.prisma.runAsAdmin((tx) =>
      tx.crmDemoEvent.deleteMany({ where: { id: { in: stale.map((r) => r.id) } } }),
    );
  }
}

function mapDemoEvent(row: CrmDemoEvent): CrmDemoEventResponse {
  const payload = row.payload as unknown as CrmEventPayload;
  return {
    reference: row.reference,
    event: row.eventType as CrmEventType,
    status: row.status as CrmTransactionStatus,
    transaction: payload.transaction,
    receivedAt: row.receivedAt.toISOString(),
  };
}
