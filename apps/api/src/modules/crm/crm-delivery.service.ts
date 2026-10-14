import { createHmac } from 'node:crypto';
import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@app/db';
import type { CrmEventPayload } from '@app/shared';
import { PrismaService } from '../../database/prisma.service';
import type { Env } from '../../config/env.schema';
import { assertSafeWebhookUrl, safeFetch } from '../../common/net/ssrf';
import { CacheService } from '../cache/cache.service';
import { CrmDemoInboxService } from './crm-demo-inbox.service';
import { registerBackgroundJob } from '../../common/lifecycle/background-jobs';
import { DeliveryLanes } from './delivery-lanes';

// Hard cap per attempt so a slow/hostile CRM can't tie up the worker.
const DELIVERY_TIMEOUT_MS = 5000;
// Backoff between retries, indexed by attempt number (1-based). After the last
// entry is used the delivery is marked FAILED.
const RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 3600_000];
const MAX_ATTEMPTS = RETRY_BACKOFF_MS.length + 1; // 6: one immediate + 5 retries
// The retry sweep runs every 20s, and again at once while it finds a full
// batch, so a backlog (a CRM that was down for a while) is worked through
// continuously rather than one batch per tick.
const JOB_INTERVAL_MS = 20_000;
const JOB_BATCH = 200;
// At most this many of one company's deliveries per batch: a company with a
// large backlog (its CRM is down) cannot fill the batch and hold up others.
const JOB_BATCH_PER_COMPANY = 25;
// Deliveries in flight at once from this API, and to any one company's CRM
// (see DeliveryLanes): a slow or dead CRM holds at most 32 slots, never all.
const MAX_IN_FLIGHT = 256;
const MAX_IN_FLIGHT_PER_COMPANY = 32;
// Waiting deliveries held in memory; past this the sweep takes them from the
// database instead (each is a durable row either way).
const MAX_QUEUED = 50_000;
// Every attempt first CLAIMS its delivery for this long — longer than any
// attempt takes — in one atomic UPDATE. Whoever starts an attempt (the first
// one, the sweep, another API instance) therefore owns it alone: a delivery is
// never POSTed twice at the same time, whatever the timing.
const CLAIM_MS = DELIVERY_TIMEOUT_MS + 25_000;
// The sweep lock across instances only saves duplicate work now (the claim
// is what prevents a double POST), so it is held per batch, briefly.
const SWEEP_LOCK_TTL_MS = 2 * 60_000;
// Truncate the stored CRM response so a chatty endpoint can't bloat a row.
const MAX_RESPONSE_BODY = 2000;

/**
 * Durable, retried delivery of CRM events. A delivery is a `webhook_deliveries`
 * row; it is attempted once straight away (`deliverSoon`, from the dispatcher)
 * and again by the background sweep until it succeeds or exhausts its retries.
 * Both go through the same lanes (fair per company, bounded) and the same
 * atomic claim. The built-in demo target is delivered in-process (no network /
 * no SSRF) so the preview works on localhost and in docker; everything else is
 * a real outbound POST carrying the company's API key in the Authorization
 * header.
 */
@Injectable()
export class CrmDeliveryService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(CrmDeliveryService.name);
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private stopping = false;
  private readonly lanes = new DeliveryLanes({
    maxInFlight: MAX_IN_FLIGHT,
    perCompany: MAX_IN_FLIGHT_PER_COMPANY,
    maxQueued: MAX_QUEUED,
  });

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly demoInbox: CrmDemoInboxService,
    private readonly cache: CacheService,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.sweep(), JOB_INTERVAL_MS);
    // A shutdown stops new runs and waits for the deliveries in flight (main.ts).
    registerBackgroundJob({
      name: 'crm-delivery',
      stop: () => this.requestStop(),
      isRunning: () => this.running || this.lanes.inFlight > 0,
    });
    this.timer.unref?.();
  }

  /**
   * Shutdown: no new sweep and no new attempt; the attempts in flight finish.
   * What was waiting stays a due row for the next instance's sweep.
   */
  requestStop(): void {
    this.stopping = true;
    this.lanes.close();
    this.onModuleDestroy();
  }

  /**
   * The first attempt of a new delivery, as soon as a lane is free. The row was
   * created with `nextRetryAt = firstAttemptAt` (the sweep leaves it alone until
   * then); the attempt claims it only if that is still so, so if the sweep got
   * there first it is not sent again. When the lanes are full it is handed to
   * the sweep at once instead.
   */
  deliverSoon(deliveryId: string, companyId: string, firstAttemptAt: Date): void {
    const queued = this.lanes.run(companyId, () => this.deliver(deliveryId, firstAttemptAt));
    if (queued) return;
    void this.prisma
      .runAsAdmin((tx) =>
        tx.webhookDelivery.updateMany({
          where: { id: deliveryId, status: 'PENDING', nextRetryAt: firstAttemptAt },
          data: { nextRetryAt: new Date() },
        }),
      )
      .catch((err) =>
        this.logger.warn(
          `CRM delivery ${deliveryId} left for the sweep: ${(err as Error).message}`,
        ),
      );
  }

  /**
   * Claim a delivery for one attempt, atomically: due (or, for its first
   * attempt, still exactly as the dispatcher created it) and not delivered or
   * failed. Null = someone else has it, or it is no longer due.
   */
  private async claim(deliveryId: string, firstAttemptAt?: Date): Promise<ClaimedDelivery | null> {
    const now = new Date();
    const until = new Date(now.getTime() + CLAIM_MS);
    const due = firstAttemptAt
      ? Prisma.sql`w.next_retry_at = ${firstAttemptAt}`
      : Prisma.sql`(w.next_retry_at IS NULL OR w.next_retry_at <= ${now})`;
    // One statement claims it AND reads the company's CRM key: every database
    // round trip counts when thousands of events are delivered at once.
    const rows = await this.prisma.runAsAdmin(
      (tx) => tx.$queryRaw<ClaimedDelivery[]>`
        UPDATE webhook_deliveries w SET next_retry_at = ${until}
        FROM companies c
        WHERE w.id = ${deliveryId}::uuid AND c.id = w.company_id
          AND w.status IN ('PENDING', 'RETRYING') AND ${due}
        RETURNING w.id, w.company_id AS "companyId", w.payload, w.target_url AS "targetUrl",
                  w.attempts, c.crm_api_key AS "crmApiKey", c.crm_demo_token AS "crmDemoToken"`,
    );
    return rows[0] ?? null;
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Attempt one delivery, if it can be claimed (see `claim`). Never throws —
   * updates the row's status in place.
   */
  async deliver(deliveryId: string, firstAttemptAt?: Date): Promise<void> {
    const row = await this.claim(deliveryId, firstAttemptAt);
    if (!row) return;

    const payload = row.payload as unknown as CrmEventPayload;
    const company = { crmApiKey: row.crmApiKey, crmDemoToken: row.crmDemoToken };

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
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-crm-event': payload.event,
      'x-crm-timestamp': timestamp,
    };
    if (company?.crmApiKey) {
      headers.authorization = `Bearer ${company.crmApiKey}`;
      // Additive HMAC-SHA256 signature so the receiver can verify the POST really
      // came from us and reject tampered or replayed bodies — keyed by the
      // company's CRM key, over `${timestamp}.${rawBody}`. Receivers that only
      // check the Bearer key are unaffected (extra header, ignored).
      headers['x-crm-signature'] = crmSignature(company.crmApiKey, timestamp, body);
    }

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
        // Read the (small) answer so the connection is free for the next event.
        await safeText(res);
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
    row: ClaimedDelivery,
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

  /**
   * Background sweep: re-attempt every delivery whose retry is due, oldest
   * first, at most JOB_BATCH_PER_COMPANY of one company per batch, through the
   * lanes. While more is due the next batch follows at once.
   */
  private async sweep(): Promise<void> {
    if (this.running || this.stopping) return;
    this.running = true;
    try {
      for (;;) {
        // Cross-instance guard: if another API replica is sweeping, skip — it
        // covers the same rows. Fails open when Redis is down (the claim still
        // keeps every delivery single).
        const lock = await this.cache.tryLock('crm-delivery-sweep', SWEEP_LOCK_TTL_MS);
        if (!lock) return;
        let more = false;
        try {
          const due = await this.prisma.runAsAdmin(
            (tx) => tx.$queryRaw<Array<{ id: string; companyId: string }>>`
              SELECT id, company_id AS "companyId" FROM (
                SELECT id, company_id, next_retry_at,
                       row_number() OVER (PARTITION BY company_id
                                          ORDER BY next_retry_at NULLS FIRST) AS turn
                FROM webhook_deliveries
                WHERE status IN ('PENDING', 'RETRYING')
                  AND (next_retry_at IS NULL OR next_retry_at <= ${new Date()})
              ) due
              WHERE turn <= ${JOB_BATCH_PER_COMPANY}
              ORDER BY next_retry_at NULLS FIRST
              LIMIT ${JOB_BATCH}`,
          );
          // More may be due when the batch was full, or a company had its whole
          // share in it — unless the lanes are full, in which case the next
          // tick takes the rest.
          const perCompany = new Map<string, number>();
          for (const d of due) perCompany.set(d.companyId, (perCompany.get(d.companyId) ?? 0) + 1);
          const runs = due.map((d) => this.lanes.run(d.companyId, () => this.deliver(d.id)));
          more =
            !runs.includes(null) &&
            (due.length === JOB_BATCH ||
              [...perCompany.values()].some((n) => n === JOB_BATCH_PER_COMPANY));
          await Promise.all(runs);
        } finally {
          await this.cache.unlock('crm-delivery-sweep', lock);
        }
        if (!more || this.stopping) return;
      }
    } catch (err) {
      this.logger.warn(`CRM delivery sweep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}

/** What an attempt needs of the delivery it claimed. */
interface ClaimedDelivery {
  id: string;
  companyId: string;
  payload: Prisma.JsonValue;
  targetUrl: string;
  attempts: number;
  crmApiKey: string | null;
  crmDemoToken: string | null;
}

/**
 * Signature for an outbound CRM webhook: `t=<unixSeconds>,sha256=<hex>`, an
 * HMAC-SHA256 over `${timestamp}.${rawBody}` keyed by the company's CRM key.
 * The receiver recomputes it with their own key and compares (and may reject a
 * `t` that is too old to defeat replays). Mirrors the Whish outbound format.
 */
export function crmSignature(secret: string, timestamp: string, body: string): string {
  const sig = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},sha256=${sig}`;
}

async function safeText(res: { text(): Promise<string> }): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
