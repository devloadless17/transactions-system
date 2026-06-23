import { Injectable, Logger } from '@nestjs/common';
import {
  isAdminRole,
  type ListNotificationsQuery,
  type NotificationEvent,
  type NotificationFlow,
  type NotificationListResponse,
  type NotificationResponse,
  type NotificationScope,
} from '@app/shared';
import type { Prisma } from '@app/db';
import { PrismaService } from '../../database/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import type { AuthPrincipal } from '../../common/types/request.types';
import { NotFoundError, ValidationError } from '../../common/errors/domain.error';

// Reject offsets beyond this — deep paging should narrow with filters instead of
// scanning, mirroring the transactions/activity lists.
const MAX_LIST_OFFSET = 50_000;

const FLOW_LABEL: Record<NotificationFlow, string> = {
  WITHDRAWAL: 'withdrawal',
  PAYOUT: 'payout',
  LOAD: 'load',
};
const FLOW_PATH: Record<NotificationFlow, string> = {
  WITHDRAWAL: 'withdrawals',
  PAYOUT: 'payouts',
  LOAD: 'loads',
};
// REJECTED reads as "declined" to the company ("approved or declined").
const EVENT_PAST: Record<NotificationEvent, string> = {
  REQUESTED: 'requested',
  APPROVED: 'approved',
  REJECTED: 'declined',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
};

interface CreateInput {
  scope: NotificationScope;
  companyId: string | null;
  flow: NotificationFlow;
  event: NotificationEvent;
  title: string;
  body: string;
  link: string;
  entityId?: string | null;
  companyName?: string | null;
}

/**
 * In-app notifications. Creation is best-effort and post-commit — the money
 * flows call the convenience builders after their transaction commits, so a
 * notification failure can never roll back or block a money operation.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  // ---------- creation (called by the money services) ----------

  /** A company submitted a request → notify platform admins to action it. */
  async requestSubmitted(p: {
    flow: NotificationFlow;
    companyId: string;
    entityId: string;
    amount: string;
    currency: string;
  }): Promise<void> {
    try {
      const company = await this.prisma.runAsAdmin((tx) =>
        tx.company.findUnique({ where: { id: p.companyId }, select: { name: true } }),
      );
      const name = company?.name ?? null;
      await this.create({
        scope: 'ADMIN',
        companyId: p.companyId,
        companyName: name,
        flow: p.flow,
        event: 'REQUESTED',
        entityId: p.entityId,
        title: `New ${FLOW_LABEL[p.flow]} request`,
        body: `${name ?? 'A company'} requested a ${FLOW_LABEL[p.flow]} of ${p.amount} ${p.currency}.`,
        link: `/admin/${FLOW_PATH[p.flow]}`,
      });
    } catch (e) {
      this.logger.warn(`notify requestSubmitted failed: ${(e as Error).message}`);
    }
  }

  /** An admin resolved a request → notify the requesting company. */
  async requestResolved(p: {
    flow: NotificationFlow;
    event: Extract<NotificationEvent, 'APPROVED' | 'REJECTED' | 'COMPLETED' | 'CANCELLED'>;
    companyId: string;
    entityId: string;
    amount: string;
    currency: string;
  }): Promise<void> {
    try {
      const label = FLOW_LABEL[p.flow];
      await this.create({
        scope: 'COMPANY',
        companyId: p.companyId,
        flow: p.flow,
        event: p.event,
        entityId: p.entityId,
        title: `${label.charAt(0).toUpperCase()}${label.slice(1)} ${EVENT_PAST[p.event]}`,
        body: `Your ${label} of ${p.amount} ${p.currency} was ${EVENT_PAST[p.event]}.`,
        link: `/app/${FLOW_PATH[p.flow]}`,
      });
    } catch (e) {
      this.logger.warn(`notify requestResolved failed: ${(e as Error).message}`);
    }
  }

  private async create(input: CreateInput): Promise<void> {
    // ADMIN rows store company_id = NULL (RLS can't expose them to a tenant);
    // the subject company lives in metadata for display.
    const tenantCompanyId = input.scope === 'COMPANY' ? input.companyId : null;
    await this.prisma.runAsAdmin((tx) =>
      tx.notification.create({
        data: {
          scope: input.scope,
          companyId: tenantCompanyId,
          flow: input.flow,
          event: input.event,
          title: input.title,
          body: input.body,
          link: input.link,
          entityId: input.entityId ?? null,
          metadata:
            input.scope === 'ADMIN'
              ? ({
                  companyId: input.companyId,
                  companyName: input.companyName ?? null,
                } as Prisma.InputJsonValue)
              : undefined,
        },
      }),
    );
    // Push to the right room so the bell + sound fire instantly.
    if (input.scope === 'ADMIN') this.realtime.admin(['notifications']);
    else if (input.companyId) this.realtime.company(input.companyId, ['notifications']);
  }

  // ---------- reads (the bell) ----------

  async list(
    user: AuthPrincipal,
    query: ListNotificationsQuery,
  ): Promise<NotificationListResponse> {
    const isAdmin = isAdminRole(user.role);
    const scope: NotificationScope = isAdmin ? 'ADMIN' : 'COMPANY';
    const companyId = isAdmin ? null : (user.companyId ?? null);
    const uid = user.userId;
    // Scope base (RLS also enforces it; explicit for the admin-bypass path).
    const base: Prisma.NotificationWhereInput = isAdmin ? { scope } : { scope, companyId };
    // active = not cleared by me; unread = I never saw it; cleared = I dismissed it.
    const where: Prisma.NotificationWhereInput =
      query.filter === 'unread'
        ? { ...base, reads: { none: { userId: uid } } }
        : query.filter === 'cleared'
          ? { ...base, reads: { some: { userId: uid, dismissedAt: { not: null } } } }
          : { ...base, reads: { none: { userId: uid, dismissedAt: { not: null } } } };
    const skip = (query.page - 1) * query.pageSize;
    if (skip > MAX_LIST_OFFSET) {
      throw new ValidationError('Page too deep to scan efficiently. Narrow the date range.');
    }

    return this.prisma.runAsScoped(companyId, async (tx) => {
      const [rows, total, unreadCount] = await Promise.all([
        tx.notification.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip,
          take: query.pageSize,
          include: { reads: { where: { userId: uid }, select: { id: true } } },
        }),
        tx.notification.count({ where }),
        // Badge = unseen AND not cleared (a cleared item has a read row).
        tx.notification.count({ where: { ...base, reads: { none: { userId: uid } } } }),
      ]);
      return {
        data: rows.map((r) => this.map(r)),
        meta: {
          page: query.page,
          pageSize: query.pageSize,
          total,
          totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
        },
        unreadCount,
      };
    });
  }

  async markRead(id: string, user: AuthPrincipal): Promise<void> {
    const isAdmin = isAdminRole(user.role);
    const scope: NotificationScope = isAdmin ? 'ADMIN' : 'COMPANY';
    const companyId = isAdmin ? null : (user.companyId ?? null);
    await this.prisma.runAsScoped(companyId, async (tx) => {
      const n = await tx.notification.findFirst({
        where: isAdmin ? { id, scope } : { id, scope, companyId },
        select: { id: true },
      });
      if (!n) throw new NotFoundError('Notification', id);
      await tx.notificationRead.upsert({
        where: { notificationId_userId: { notificationId: id, userId: user.userId } },
        create: { notificationId: id, userId: user.userId, companyId },
        update: {},
      });
    });
    this.emitNotificationsChanged(user);
  }

  async markAllRead(user: AuthPrincipal): Promise<void> {
    const isAdmin = isAdminRole(user.role);
    const scope: NotificationScope = isAdmin ? 'ADMIN' : 'COMPANY';
    const companyId = isAdmin ? null : (user.companyId ?? null);
    await this.prisma.runAsScoped(companyId, async (tx) => {
      const unread = await tx.notification.findMany({
        where: isAdmin
          ? { scope, reads: { none: { userId: user.userId } } }
          : { scope, companyId, reads: { none: { userId: user.userId } } },
        select: { id: true },
      });
      if (unread.length === 0) return;
      await tx.notificationRead.createMany({
        data: unread.map((n) => ({ notificationId: n.id, userId: user.userId, companyId })),
        skipDuplicates: true,
      });
    });
    this.emitNotificationsChanged(user);
  }

  /** Clear (dismiss) a single notification for this user — hidden from active. */
  async dismiss(id: string, user: AuthPrincipal): Promise<void> {
    const isAdmin = isAdminRole(user.role);
    const scope: NotificationScope = isAdmin ? 'ADMIN' : 'COMPANY';
    const companyId = isAdmin ? null : (user.companyId ?? null);
    await this.prisma.runAsScoped(companyId, async (tx) => {
      const n = await tx.notification.findFirst({
        where: isAdmin ? { id, scope } : { id, scope, companyId },
        select: { id: true },
      });
      if (!n) throw new NotFoundError('Notification', id);
      const now = new Date();
      await tx.notificationRead.upsert({
        where: { notificationId_userId: { notificationId: id, userId: user.userId } },
        create: { notificationId: id, userId: user.userId, companyId, dismissedAt: now },
        update: { dismissedAt: now },
      });
    });
    this.emitNotificationsChanged(user);
  }

  /** Clear all of this user's notifications in one shot (idempotent upsert). */
  async clearAll(user: AuthPrincipal): Promise<void> {
    const isAdmin = isAdminRole(user.role);
    const companyId = isAdmin ? null : (user.companyId ?? null);
    await this.prisma.runAsScoped(companyId, async (tx) => {
      if (isAdmin) {
        await tx.$executeRawUnsafe(
          `INSERT INTO notification_reads (id, notification_id, user_id, company_id, dismissed_at)
           SELECT gen_random_uuid(), n.id, $1::uuid, NULL, now()
           FROM notifications n WHERE n.scope = 'ADMIN' AND n.company_id IS NULL
           ON CONFLICT (notification_id, user_id) DO UPDATE SET dismissed_at = now()`,
          user.userId,
        );
      } else {
        await tx.$executeRawUnsafe(
          `INSERT INTO notification_reads (id, notification_id, user_id, company_id, dismissed_at)
           SELECT gen_random_uuid(), n.id, $1::uuid, $2::uuid, now()
           FROM notifications n WHERE n.scope = 'COMPANY' AND n.company_id = $2::uuid
           ON CONFLICT (notification_id, user_id) DO UPDATE SET dismissed_at = now()`,
          user.userId,
          companyId,
        );
      }
    });
    this.emitNotificationsChanged(user);
  }

  /**
   * Nudge this user's OTHER open tabs/devices to refresh the unread bell after a
   * read-state change (mark/dismiss/clear). Realtime rooms are admin/company-level
   * (not per-user), so this asks everyone in scope to recompute their OWN unread
   * count — cheap, and never leaks another tenant's data (company scope → company
   * room only). The acting tab already updates via its own query invalidation.
   */
  private emitNotificationsChanged(user: AuthPrincipal): void {
    if (isAdminRole(user.role)) this.realtime.admin(['notifications']);
    else if (user.companyId) this.realtime.company(user.companyId, ['notifications']);
  }

  private map(r: {
    id: string;
    scope: string;
    flow: string;
    event: string;
    title: string;
    body: string;
    link: string;
    entityId: string | null;
    metadata: Prisma.JsonValue;
    createdAt: Date;
    reads: Array<{ id: string }>;
  }): NotificationResponse {
    const meta = (r.metadata ?? {}) as { companyName?: string | null };
    return {
      id: r.id,
      scope: r.scope as NotificationScope,
      flow: r.flow as NotificationFlow,
      event: r.event as NotificationEvent,
      title: r.title,
      body: r.body,
      link: r.link,
      entityId: r.entityId,
      companyName: meta.companyName ?? null,
      read: r.reads.length > 0,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
