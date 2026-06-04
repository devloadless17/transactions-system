import { Body, Controller, Headers, Param, Post } from '@nestjs/common';
import crypto from 'node:crypto';
import { crmEventPayloadSchema, type CrmEventPayload } from '@app/shared';
import { ZodPipe } from '../../common/pipes/zod-validation.pipe';
import { PrismaService } from '../../database/prisma.service';
import { ForbiddenError } from '../../common/errors/domain.error';
import { CrmDemoInboxService } from './crm-demo-inbox.service';

/**
 * The built-in demo CRM's receiving endpoint — a REAL public POST API that
 * captures the events we send, exactly as a company's own CRM would. The
 * company enables it from the CRM settings; we then deliver here authenticating
 * with their demo key in the Authorization header (the same contract as a real
 * CRM). Received events surface live in their preview inbox.
 *
 * UNAUTHENTICATED guard-wise (no JWT/CSRF) — it authenticates by the per-company
 * demo token in the path plus a timing-safe Bearer-key check.
 */
@Controller('crm-demo')
export class CrmDemoController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly demoInbox: CrmDemoInboxService,
  ) {}

  @Post(':token/inbox')
  async receive(
    @Param('token') token: string,
    @Headers('authorization') authorization: string | undefined,
    @Body(new ZodPipe(crmEventPayloadSchema)) payload: CrmEventPayload,
  ): Promise<{ received: boolean }> {
    const company = await this.prisma.runAsAdmin((tx) =>
      tx.company.findUnique({
        where: { crmDemoToken: token },
        select: { id: true, crmDemoKey: true },
      }),
    );
    if (!company?.crmDemoKey) throw new ForbiddenError('Unknown demo inbox');

    const provided = (authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!timingSafeEqual(provided, company.crmDemoKey)) {
      throw new ForbiddenError('Invalid demo API key');
    }

    await this.demoInbox.receive(company.id, payload);
    return { received: true };
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
