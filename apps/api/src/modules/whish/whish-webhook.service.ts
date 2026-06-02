import { Injectable, Logger } from '@nestjs/common';
import crypto from 'node:crypto';
import type { WhishPayment } from '@app/db';
import type { WhishWebhookConfig } from '@app/shared';
import { PrismaService } from '../../database/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';

/**
 * Outbound webhooks to a company's own endpoint (e.g. their CRM). On a
 * confirmed payment we POST a signed JSON event so the company doesn't have to
 * poll. Delivery is best-effort (a couple of attempts, never blocks settlement);
 * the company can always fall back to polling /integrations/whish/payments/:ref.
 */
@Injectable()
export class WhishWebhookService {
  private readonly logger = new Logger(WhishWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  /** Fire the `whish.payment.paid` event for a settled payment (fire-and-forget). */
  async deliverPaid(payment: WhishPayment): Promise<void> {
    const company = await this.prisma.runAsAdmin((tx) =>
      tx.company.findUnique({
        where: { id: payment.companyId },
        select: { webhookUrl: true, webhookSecret: true },
      }),
    );
    if (!company?.webhookUrl) return;

    const body = JSON.stringify({
      event: 'whish.payment.paid',
      data: {
        externalId: payment.externalId.toString(),
        status: payment.status,
        amount: payment.amount.toString(),
        currency: payment.currency.trim(),
        invoice: payment.invoice,
        payerPhoneNumber: payment.payerPhoneNumber,
        transactionId: payment.transactionId,
        paidAt: payment.paidAt?.toISOString() ?? null,
      },
    });
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-whish-event': 'whish.payment.paid',
    };
    if (company.webhookSecret) {
      const sig = crypto.createHmac('sha256', company.webhookSecret).update(body).digest('hex');
      headers['x-whish-signature'] = `sha256=${sig}`;
    }

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetch(company.webhookUrl, { method: 'POST', headers, body });
        if (res.ok) {
          this.logger.log(
            `Webhook delivered: payment ${payment.externalId} → ${company.webhookUrl}`,
          );
          return;
        }
        this.logger.warn(
          `Webhook ${company.webhookUrl} responded HTTP ${res.status} (attempt ${attempt})`,
        );
      } catch (err) {
        this.logger.warn(
          `Webhook delivery to ${company.webhookUrl} failed (attempt ${attempt}): ${(err as Error).message}`,
        );
      }
    }
  }

  // ---- config (company-managed) ----

  async getConfig(companyId: string): Promise<WhishWebhookConfig> {
    const c = await this.prisma.runAsTenant(companyId, (tx) =>
      tx.company.findUnique({
        where: { id: companyId },
        select: { webhookUrl: true, webhookSecret: true },
      }),
    );
    return { url: c?.webhookUrl ?? null, hasSecret: !!c?.webhookSecret };
  }

  /** Set the webhook URL; generates a signing secret on first set (returned once). */
  async setUrl(companyId: string, url: string): Promise<WhishWebhookConfig> {
    const existing = await this.prisma.runAsTenant(companyId, (tx) =>
      tx.company.findUnique({ where: { id: companyId }, select: { webhookSecret: true } }),
    );
    const newSecret = existing?.webhookSecret ? undefined : generateSecret();
    await this.prisma.runAsTenant(companyId, (tx) =>
      tx.company.update({
        where: { id: companyId },
        data: { webhookUrl: url, ...(newSecret ? { webhookSecret: newSecret } : {}) },
      }),
    );
    this.realtime.company(companyId, ['whish']);
    return { url, hasSecret: true, ...(newSecret ? { secret: newSecret } : {}) };
  }

  async rotateSecret(companyId: string): Promise<WhishWebhookConfig> {
    const secret = generateSecret();
    const c = await this.prisma.runAsTenant(companyId, (tx) =>
      tx.company.update({
        where: { id: companyId },
        data: { webhookSecret: secret },
        select: { webhookUrl: true },
      }),
    );
    this.realtime.company(companyId, ['whish']);
    return { url: c.webhookUrl, hasSecret: true, secret };
  }

  async clear(companyId: string): Promise<WhishWebhookConfig> {
    await this.prisma.runAsTenant(companyId, (tx) =>
      tx.company.update({
        where: { id: companyId },
        data: { webhookUrl: null, webhookSecret: null },
      }),
    );
    this.realtime.company(companyId, ['whish']);
    return { url: null, hasSecret: false };
  }
}

function generateSecret(): string {
  return `whsec_${crypto.randomBytes(24).toString('hex')}`;
}
