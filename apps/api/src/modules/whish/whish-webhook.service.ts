import { Injectable, Logger } from '@nestjs/common';
import crypto from 'node:crypto';
import type { WhishPayment } from '@app/db';
import type { WhishWebhookConfig } from '@app/shared';
import { PrismaService } from '../../database/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { assertSafeWebhookUrl, safeFetch } from '../../common/net/ssrf';
import { ValidationError } from '../../common/errors/domain.error';

// Hard cap on outbound webhook attempts so a slow/hostile endpoint can't tie up
// the settlement path.
const WEBHOOK_TIMEOUT_MS = 5000;

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
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-whish-event': 'whish.payment.paid',
      'x-whish-timestamp': timestamp,
    };
    if (company.webhookSecret) {
      // Sign `timestamp.body` (not just body) so the receiver can reject
      // replays by checking the timestamp is recent before trusting the sig.
      const sig = crypto
        .createHmac('sha256', company.webhookSecret)
        .update(`${timestamp}.${body}`)
        .digest('hex');
      headers['x-whish-signature'] = `t=${timestamp},sha256=${sig}`;
    }

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        // safeFetch re-validates the URL and pins the connection to the validated
        // IP at send time, so a URL re-pointed at an internal address (DNS
        // rebinding) can't be reached.
        const res = await safeFetch(company.webhookUrl, {
          method: 'POST',
          headers,
          body,
          redirect: 'manual',
          signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
        });
        // Read the (small) answer so the connection is free for reuse.
        await res.text().catch(() => '');
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
        // A disallowed/unsafe URL won't become safe on retry — skip immediately.
        if (err instanceof ValidationError) {
          this.logger.warn(
            `Skipping webhook for payment ${payment.externalId}: unsafe URL ${company.webhookUrl} (${err.message})`,
          );
          return;
        }
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
    // Reject https-only/private-address violations up front (400) rather than
    // silently storing a URL that will be skipped at delivery time.
    await assertSafeWebhookUrl(url);
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
