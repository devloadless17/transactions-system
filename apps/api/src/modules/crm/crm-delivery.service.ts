import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { WebhookDelivery } from '@app/db';
import type { CrmEventPayload } from '@app/shared';
import { PrismaService } from '../../database/prisma.service';
import type { Env } from '../../config/env.schema';
import { assertSafeWebhookUrl, safeFetch } from '../../common/net/ssrf';
import { CacheService } from '../cache/cache.service';
import { CrmDemoInboxService } from './crm-demo-inbox.service';

// Hard cap per attempt so a slow/hostile CRM can't tie up the worker.
const DELIVERY_TIMEOUT_MS = 5000;
// Backoff between retries, indexed by attempt number (1-based). After the last
// entry is used the delivery is marked FAILED.
const RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 3600_000];
const MAX_ATTEMPTS = RETRY_BACKOFF_MS.length + 1; // 6: one immediate + 5 retries
// How often the retry sweep runs, and how many due rows it claims per tick.
const JOB_INTERVAL_MS = 20_000;
const JOB_BATCH = 50;
// The cross-instance sweep lock must outlive the WORST-CASE sweep, not one tick:
// the batch runs sequentially and each delivery can block up to DELIVERY_TIMEOUT_MS,
// so a full slow batch is ~JOB_BATCH * DELIVERY_TIMEOUT_MS. If the lock lapsed
// mid-sweep a second replica would re-claim the unprocessed rows and double-POST
// them. (On a crash the lock still self-heals after this TTL.)
const SWEEP_LOCK_TTL_MS = JOB_BATCH * DELIVERY_TIMEOUT_MS + 30_000;
// Truncate the stored CRM response so a chatty endpoint can't bloat a row.
const MAX_RESPONSE_BODY = 2000;

/**
 * Durable, retried delivery of CRM events. A delivery is a `webhook_deliveries`
 * row; `deliver` is called once immediately by the dispatcher and again by the
 * background sweep until it succeeds or exhausts its retries. The built-in demo
 * target is delivered in-process (no network / no SSRF) so the preview works on
 * localhost and in docker; everything else is a real outbound POST carrying the
 * company's API key in the Authorization header.
 */
@Injectable()
export class CrmDeliveryService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(CrmDeliveryService.name);
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly demoInbox: CrmDemoInboxService,
    private readonly cache: CacheService,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.sweep(), JOB_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Attempt one delivery. Never throws — updates the row's status in place. */
  async deliver(deliveryId: string): Promise<void> {
    const row = await this.prisma.runAsAdmin((tx) =>
      tx.webhookDelivery.findUnique({ where: { id: deliveryId } }),
    );
    if (!row || row.status === 'DELIVERED' || row.status === 'FAILED') return;

    const payload = row.payload as unknown as CrmEventPayload;
    const company = await this.prisma.runAsAdmin((tx) =>
      tx.company.findUnique({
        where: { id: row.companyId },
        select: { crmApiKey: true, crmDemoToken: true },
      }),
    );

    // Built-in demo target → capture in-process (instant, no SSRF, works locally).
    // Routed by the company's OWN demo token (exact match), never a look-alike
    // free-text URL, so the SSRF-bypassing in-process path can't be triggered by
    // a crafted crmApiUrl.
    const base = this.config.get('API_PUBLIC_URL', { infer: true });
    if (
      company?.crmDemoToken &&
      row.targetUrl === `${base}/crm-demo/${company.crmDemoToken}/inbox`
    ) {
      try {
        await this.demoInbox.receive(row.companyId, payload);
        await this.markDelivered(row.id, row.attempts + 1, 200);
      } catch (err) {
        await this.markFailedAttempt(row, null, (err as Error).message);
      }
      return;
    }

    // Real external CRM → outbound POST with the company's API key.
    try {
      // Re-validate at send time (DNS rebinding / a URL re-pointed at an internal
      // address after it was saved). An unsafe URL is a permanent config error,
      // not a transient failure — fail it fast instead of retrying for hours.
      await assertSafeWebhookUrl(row.targetUrl);
    } catch (err) {
      await this.markFailedAttempt(row, null, `unsafe URL: ${(err as Error).message}`, true);
      return;
    }

    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-crm-event': payload.event,
      'x-crm-timestamp': Math.floor(Date.now() / 1000).toString(),
    };
    if (company?.crmApiKey) headers.authorization = `Bearer ${company.crmApiKey}`;

    try {
      // safeFetch re-validates and pins the connection to the validated IP, so a
      // rebind to an internal address between the check above and connect is moot.
      const res = await safeFetch(row.targetUrl, {
        method: 'POST',
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      if (res.ok) {
        await this.markDelivered(row.id, row.attempts + 1, res.status);
        this.logger.log(`CRM delivered ${payload.event} ${payload.reference} → ${row.targetUrl}`);
        return;
      }
      await this.markFailedAttempt(row, res.status, await safeText(res));
    } catch (err) {
      await this.markFailedAttempt(row, null, (err as Error).message);
    }
  }

  private async markDelivered(id: string, attempts: number, status: number): Promise<void> {
    await this.prisma.runAsAdmin((tx) =>
      tx.webhookDelivery.update({
        where: { id },
        data: {
          status: 'DELIVERED',
          attempts,
          lastAttemptAt: new Date(),
          deliveredAt: new Date(),
          responseStatus: status,
          nextRetryAt: null,
        },
      }),
    );
  }

  private async markFailedAttempt(
    row: WebhookDelivery,
    responseStatus: number | null,
    responseBody: string,
    nonRetryable = false,
  ): Promise<void> {
    const attempts = row.attempts + 1;
    // Only retry TRANSIENT failures: network/timeout (null), rate limit (429),
    // and 5xx. An auth/client error (401, 403, 400, 404, 409, 422 …) or a
    // permanently-unsafe URL (`nonRetryable`) won't fix itself by retrying — it
    // needs a config change — so fail it immediately instead of re-hammering the
    // CRM for hours.
    const retryable =
      !nonRetryable && (responseStatus === null || responseStatus === 429 || responseStatus >= 500);
    const exhausted = !retryable || attempts >= MAX_ATTEMPTS;
    const backoff = RETRY_BACKOFF_MS[Math.min(attempts - 1, RETRY_BACKOFF_MS.length - 1)]!;
    await this.prisma.runAsAdmin((tx) =>
      tx.webhookDelivery.update({
        where: { id: row.id },
        data: {
          status: exhausted ? 'FAILED' : 'RETRYING',
          attempts,
          lastAttemptAt: new Date(),
          nextRetryAt: exhausted ? null : new Date(Date.now() + backoff),
          responseStatus: responseStatus ?? undefined,
          responseBody: responseBody.slice(0, MAX_RESPONSE_BODY),
        },
      }),
    );
    this.logger.warn(
      `CRM delivery ${row.id} attempt ${attempts} failed (${responseStatus ?? 'network'}): ${
        exhausted
          ? retryable
            ? 'giving up (FAILED)'
            : 'not retryable — auth/client error (FAILED)'
          : `retrying in ${Math.round(backoff / 1000)}s`
      }`,
    );
  }

  /** Background sweep: re-attempt every delivery whose retry is due. */
  private async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    // Cross-instance guard: if another API replica is already sweeping, skip this
    // tick so two replicas don't double-POST the same due deliveries. Fails open
    // when Redis is down — no worse than today's single-instance behavior, where
    // the in-process `running` flag already prevents overlap. (TTL > one tick so
    // the lock auto-clears if a sweep is killed mid-run.)
    const lock = await this.cache.tryLock('crm-delivery-sweep', SWEEP_LOCK_TTL_MS);
    if (!lock) {
      this.running = false;
      return;
    }
    try {
      const now = new Date();
      const due = await this.prisma.runAsAdmin((tx) =>
        tx.webhookDelivery.findMany({
          where: {
            status: { in: ['PENDING', 'RETRYING'] },
            OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
          },
          orderBy: { createdAt: 'asc' },
          take: JOB_BATCH,
          select: { id: true },
        }),
      );
      for (const d of due) await this.deliver(d.id);
    } catch (err) {
      this.logger.warn(`CRM delivery sweep failed: ${(err as Error).message}`);
    } finally {
      await this.cache.unlock('crm-delivery-sweep', lock);
      this.running = false;
    }
  }
}

async function safeText(res: { text(): Promise<string> }): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
