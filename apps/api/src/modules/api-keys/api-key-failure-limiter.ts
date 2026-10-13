import type { ExecutionContext } from '@nestjs/common';
import type { Response } from 'express';
import { RateLimitError } from '../../common/errors/domain.error';
import type { ApiKeyRateLimitStore } from './api-key-rate-limit.store';

const FAILURE_WINDOW_SECONDS = 60;
/** How long a successful (IP, prefix) pair skips the failure budgets. */
const TRUSTED_TTL_SECONDS = 10 * 60;
/**
 * The per-IP budget is a multiple of the per-prefix one. The prefix budget
 * bounds argon2 burn for ONE credential; this one bounds an attacker who
 * ROTATES the prefix every attempt (each rotation would otherwise start a fresh
 * prefix budget and never trip anything). Failures are ~0 for real callers, so
 * a generous multiple stays far from legitimate traffic.
 */
const IP_BUDGET_MULTIPLIER = 5;

/**
 * Failure budgets are keyed by client IP **and the presented key prefix**, not
 * by IP alone.
 *
 * Keying by IP alone has a collateral-lockout flaw: the budget is checked
 * BEFORE verification, so an attacker who fills an IP's budget also blocks a
 * legitimate key arriving from that same IP (shared NAT / cloud egress) — and
 * the success that would clear the budget can never happen. That would stop a
 * real deposit, which this system does not do.
 *
 * Scoping by prefix isolates them: a working key never fails, so its bucket is
 * always empty. Meanwhile the budget still bounds the thing actually worth
 * bounding — argon2 CPU burn, which only occurs when a presented prefix
 * matches a live key. Prefixes that aren't well-formed share one bucket, so an
 * attacker can't mint unbounded Redis keys with junk.
 */
export function credentialPrefix(authHeader: string | undefined): string {
  const m = /^Bearer\s+tsk_([A-Za-z0-9]{8})_/.exec(authHeader ?? '');
  return m ? m[1] : 'na';
}

/** Budget for ONE credential from one IP — bounds argon2 burn per prefix. */
export function failureBucketKey(ip: string, authHeader: string | undefined): string {
  return `rl:authfail:key:${ip}:${credentialPrefix(authHeader)}`;
}

/** Budget for the IP as a whole — bounds an attacker rotating prefixes. */
export function ipFailureBucketKey(ip: string): string {
  return `rl:authfail:ip:${ip}`;
}

/** Marker proving this credential recently authenticated from this IP. */
export function trustedKey(ip: string, authHeader: string | undefined): string {
  return `rl:authok:${ip}:${credentialPrefix(authHeader)}`;
}

/** The three counters one request is judged by. */
export interface FailureBuckets {
  perKey: string;
  perIp: string;
  trusted: string;
}

/**
 * FAILED-API-key-attempt limiting, shared by every guard that verifies a key —
 * source keys on ingest (ApiKeyAuthGuard) and company keys on the Whish Pay
 * API and every `/v1/company/*` route (CompanyApiKeyAuthGuard).
 *
 * It limits the surface an attacker actually hammers — guessing keys — and
 * never the traffic of a key that works:
 *   - checked BEFORE the key is verified, so a blocked attacker never costs us
 *     the argon2 work `verify()` does for every live key sharing a prefix;
 *   - a working key never counts, a success clears its budget, and a recently
 *     successful (IP, prefix) pair skips the budgets entirely — so a real
 *     partner can never be locked out as collateral, even when an attacker
 *     floods the same egress IP;
 *   - fails OPEN when the counter is unreachable (a Redis outage must never
 *     stop money traffic), and is skipped when there is no client IP (one
 *     shared bucket could be filled by one attacker and block everyone).
 */
export class ApiKeyFailureLimiter {
  constructor(
    private readonly limits: ApiKeyRateLimitStore,
    /** Failed attempts allowed per (IP, key prefix) per minute. */
    private readonly failureMax: number,
  ) {}

  /** The counters for this caller, or null without a client IP (limiter skipped). */
  bucketsFor(ip: string | undefined, authHeader: string | undefined): FailureBuckets | null {
    if (!ip) return null;
    return {
      perKey: failureBucketKey(ip, authHeader),
      perIp: ipFailureBucketKey(ip),
      trusted: trustedKey(ip, authHeader),
    };
  }

  /**
   * Throw a 429 (with the usual rate-limit headers) when this caller is over a
   * failure budget. A trusted (IP, prefix) pair is never blocked.
   */
  async assertNotBlocked(ctx: ExecutionContext, keys: FailureBuckets | null): Promise<void> {
    if (!keys) return;
    if (await this.limits.isTrusted(keys.trusted)) return;
    const [perKey, perIp] = await Promise.all([
      this.limits.peek(keys.perKey, FAILURE_WINDOW_SECONDS),
      this.limits.peek(keys.perIp, FAILURE_WINDOW_SECONDS),
    ]);
    const ipMax = this.failureMax * IP_BUDGET_MULTIPLIER;
    const over =
      (perKey && perKey.count >= this.failureMax
        ? { limit: this.failureMax, reset: perKey.resetSeconds }
        : null) ??
      (perIp && perIp.count >= ipMax ? { limit: ipMax, reset: perIp.resetSeconds } : null);
    if (!over) return;
    // Mirror the headers every other 429 on this API sets, so a client that
    // self-paces has something to pace against.
    const res = ctx.switchToHttp().getResponse<Response>();
    res.setHeader('RateLimit-Limit', over.limit);
    res.setHeader('RateLimit-Remaining', 0);
    res.setHeader('RateLimit-Reset', over.reset);
    res.setHeader('Retry-After', over.reset);
    throw new RateLimitError({ limit: over.limit, windowSeconds: FAILURE_WINDOW_SECONDS });
  }

  /** Count a failed attempt. Best-effort: a counter outage never changes the auth outcome. */
  async recordFailure(keys: FailureBuckets | null): Promise<void> {
    if (!keys) return;
    await Promise.all([
      this.limits.hit(keys.perKey, FAILURE_WINDOW_SECONDS).catch(() => undefined),
      this.limits.hit(keys.perIp, FAILURE_WINDOW_SECONDS).catch(() => undefined),
    ]);
  }

  /**
   * The credential is good: clear its budget and mark the (IP, prefix) pair
   * trusted, so a later flood against this IP cannot block it.
   */
  async recordSuccess(keys: FailureBuckets | null): Promise<void> {
    if (!keys) return;
    await Promise.all([
      this.limits.clear(keys.perKey, FAILURE_WINDOW_SECONDS),
      this.limits.markTrusted(keys.trusted, TRUSTED_TTL_SECONDS),
    ]);
  }
}
