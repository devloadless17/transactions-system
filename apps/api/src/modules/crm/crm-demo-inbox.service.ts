import { Injectable, Logger } from '@nestjs/common';
import type { CrmDemoEvent, Prisma } from '@app/db';
import type {
  CrmDemoEventResponse,
  CrmEventPayload,
  CrmEventStatus,
  CrmEventType,
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
 *
 * It is also the reference receiver, so it follows the rule the integration
 * guide gives every CRM: deliveries are at-least-once and NOT ordered, so an
 * event is applied only if it is newer than the one already stored for that
 * reference (see isStaleEvent).
 */
@Injectable()
export class CrmDemoInboxService {
  private readonly logger = new Logger(CrmDemoInboxService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  async receive(companyId: string, payload: CrmEventPayload): Promise<void> {
    // Exactly one body is present (transaction.* vs withdrawal.*); read the
    // status from whichever it is.
    const status = payload.transaction?.status ?? payload.withdrawal?.status ?? 'PENDING';
    const stored = await this.prisma.runAsAdmin((tx) =>
      tx.crmDemoEvent.findUnique({
        where: { companyId_reference: { companyId, reference: payload.reference } },
        select: { payload: true },
      }),
    );
    if (stored && isStaleEvent(payload, stored.payload as unknown as CrmEventPayload)) {
      // A late retry of an older event (e.g. `pending` re-sent after `completed`
      // already landed). Applying it would move the record backwards.
      this.logger.debug(`ignored stale ${payload.event} for ${payload.reference}`);
      return;
    }
    await this.prisma.runAsAdmin((tx) =>
      tx.crmDemoEvent.upsert({
        where: { companyId_reference: { companyId, reference: payload.reference } },
        create: {
          companyId,
          reference: payload.reference,
          eventType: payload.event,
          status,
          payload: payload as unknown as Prisma.InputJsonValue,
        },
        update: {
          eventType: payload.event,
          status,
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

/**
 * Whether `incoming` is older than the event already `stored` for the same
 * reference, by `sentAt` — which is fixed when an event is created and never
 * changes on a retry, so it orders one reference's events exactly. An event
 * with the SAME `sentAt` is a plain re-delivery and is applied again (it is
 * identical); anything unparseable is applied rather than silently dropped.
 */
export function isStaleEvent(
  incoming: Pick<CrmEventPayload, 'sentAt'>,
  stored: Pick<CrmEventPayload, 'sentAt'> | null | undefined,
): boolean {
  const incomingAt = Date.parse(incoming.sentAt);
  const storedAt = Date.parse(stored?.sentAt ?? '');
  if (Number.isNaN(incomingAt) || Number.isNaN(storedAt)) return false;
  return incomingAt < storedAt;
}

function mapDemoEvent(row: CrmDemoEvent): CrmDemoEventResponse {
  const payload = row.payload as unknown as CrmEventPayload;
  return {
    reference: row.reference,
    event: row.eventType as CrmEventType,
    status: row.status as CrmEventStatus,
    transaction: payload.transaction ?? null,
    withdrawal: payload.withdrawal ?? null,
    receivedAt: row.receivedAt.toISOString(),
  };
}
