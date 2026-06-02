import { Injectable } from '@nestjs/common';
import type { RealtimeTopic } from '@app/shared';
import { ADMIN_ROOM, companyRoom, RealtimeGateway } from './realtime.gateway';

/**
 * Thin façade services call after a successful mutation to tell connected
 * clients which topics went stale. Emitting is fire-and-forget and guarded
 * — a realtime failure must never break the underlying write.
 *
 * Call these AFTER the DB transaction commits, so a rolled-back mutation
 * does not announce a change that never happened.
 */
@Injectable()
export class RealtimeService {
  constructor(private readonly gateway: RealtimeGateway) {}

  /**
   * A tenant-scoped change. Notifies the company's own users and every
   * platform admin (who may be watching that company's detail page).
   */
  company(companyId: string, topics: RealtimeTopic[]): void {
    this.gateway.emit([companyRoom(companyId), ADMIN_ROOM], { topics, companyId });
  }

  /**
   * A platform-wide change with no single tenant (sources, admin users,
   * global commission rules, company list). Notifies admins only.
   * `companyId` may still be supplied when a global list change also touches
   * a specific company (e.g. a company's status/visibility flip).
   */
  admin(topics: RealtimeTopic[], companyId: string | null = null): void {
    this.gateway.emit([ADMIN_ROOM], { topics, companyId });
  }
}
