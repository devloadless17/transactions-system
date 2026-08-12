import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema';
import type { WhishCurrency } from '@app/shared';
import { z } from 'zod';
import { DomainError, ValidationError } from '../../common/errors/domain.error';

// Cap every Whish call so an unresponsive upstream can't hang the callback
// handler or the reconciliation poller indefinitely.
const WHISH_TIMEOUT_MS = 10_000;

/** Upstream Whish failure (network error or `status: false` envelope). */
export class WhishError extends DomainError {
  /**
   * The RAW upstream Whish envelope — carried for the super-admin transaction log
   * ONLY. Deliberately kept OFF `details` (which the global exception filter
   * returns to the API caller) so a company integrator never receives the
   * payment provider's internal response body.
   */
  readonly upstreamResponse?: unknown;
  constructor(
    message: string,
    details?: Record<string, unknown>,
    upstreamResponse?: unknown,
    code = 'WHISH_ERROR',
  ) {
    super(code, message, 502, details);
    this.upstreamResponse = upstreamResponse;
  }
}

/**
 * The call MAY have taken effect — Whish could not tell us either way. Per Whish
 * Pay v1.4.4: `status:false` with `code:"500"` means *pending*, "the result is
 * unknown rather than failed … do not mark it failed". Same for a timeout (the
 * request was already in flight) and a 5xx (which may sit in front of a Whish
 * that did process it).
 *
 * Extends WhishError on purpose: callers that only care "did the Whish call
 * blow up" (e.g. the super-admin transaction log) keep working unchanged, while
 * callers that must NOT settle a row check `instanceof WhishIndeterminateError`
 * FIRST. Stays HTTP 502; only `error.code` distinguishes it, so no new status
 * code enters the integrator contract.
 */
export class WhishIndeterminateError extends WhishError {
  constructor(message: string, details?: Record<string, unknown>, upstreamResponse?: unknown) {
    super(message, details, upstreamResponse, 'WHISH_PENDING');
  }
}

// The unified Whish response envelope. v1.4.4 also returns `actions`, `extra`
// and `retrieved`; we ignore them, and unknown keys are harmless here.
interface WhishEnvelope<T> {
  status: boolean;
  code: string | null;
  dialog: { title?: string | null; message?: string | null } | null;
  data: T | null;
}

export interface PostPaymentInput {
  amount: string;
  currency: string;
  invoice: string;
  /** Digit string — Whish v1.4.4 documents externalId as a String. */
  externalId: string;
  successCallbackUrl: string;
  failureCallbackUrl: string;
  successRedirectUrl: string;
  failureRedirectUrl: string;
}

/**
 * Whish Pay v1.4.4. Only `success` and `failed` are SETTLED outcomes:
 * - `pending`   the link is still payable, INCLUDING after a failed attempt
 * - `success`   paid; the link is now expired
 * - `failed`    the link expired without being paid
 * - `refunded`  a successful payment was refunded
 * - `unknown`   the final state could not be determined (NOT settled)
 */
export type WhishCollectStatus = 'success' | 'failed' | 'pending' | 'refunded' | 'unknown';

// Runtime contract for the collect status. `as` casts in `call<T>` give only
// compile-time safety, so an off-contract string (e.g. a new upstream status)
// would otherwise flow straight into reconcile() and be (mis)treated as success.
// Widened to exactly the five documented v1.4.4 values — a SIXTH, undocumented
// value must still be rejected rather than settled, so do not weaken this.
const whishCollectStatusSchema = z.enum(['success', 'failed', 'pending', 'refunded', 'unknown']);

/** Whish requires numeric content even though the JSON type is now String. */
const EXTERNAL_ID_RE = /^\d{1,19}$/;

/**
 * Thin client over the three Whish Pay endpoints. Injects the four required
 * headers (channel, secret, websiteUrl, User-Agent) on every call and unwraps
 * the `{ status, code, dialog, data }` envelope, throwing WhishError when Whish
 * reports failure. One platform-wide account (creds from env).
 */
@Injectable()
export class WhishClient {
  private readonly logger = new Logger(WhishClient.name);

  constructor(private readonly config: ConfigService<Env, true>) {}

  isConfigured(): boolean {
    return (
      !!this.config.get('WHISH_CHANNEL', { infer: true }) &&
      !!this.config.get('WHISH_SECRET', { infer: true })
    );
  }

  /** Create a payment link; returns the Whish-hosted collect URL. */
  async postPayment(input: PostPaymentInput): Promise<{ collectUrl: string }> {
    if (!EXTERNAL_ID_RE.test(input.externalId)) {
      throw new ValidationError(`externalId must be a digit string: got '${input.externalId}'`);
    }
    const data = await this.call<{ collectUrl: string }>('POST', '/payment/whish', {
      amount: input.amount,
      currency: input.currency,
      invoice: input.invoice,
      externalId: input.externalId,
      successCallbackUrl: input.successCallbackUrl,
      failureCallbackUrl: input.failureCallbackUrl,
      successRedirectUrl: input.successRedirectUrl,
      failureRedirectUrl: input.failureRedirectUrl,
    });
    if (!data?.collectUrl) throw new WhishError('Whish did not return a collect URL');
    return { collectUrl: data.collectUrl };
  }

  /** Look up the collect status of a payment by its externalId. */
  async getStatus(input: {
    currency: string;
    externalId: string;
  }): Promise<{ collectStatus: WhishCollectStatus; payerPhoneNumber: string | null }> {
    if (!EXTERNAL_ID_RE.test(input.externalId)) {
      throw new ValidationError(`externalId must be a digit string: got '${input.externalId}'`);
    }
    const data = await this.call<{
      collectStatus: WhishCollectStatus;
      payerPhoneNumber?: string | number | null;
    }>('POST', '/payment/collect/status', {
      currency: input.currency,
      externalId: input.externalId,
    });
    if (!data?.collectStatus) throw new WhishError('Whish status response missing collectStatus');
    // Validate the status against the known contract at runtime — `call<T>` only
    // casts the envelope, so an off-contract value (a new/unexpected upstream
    // status) must be rejected here rather than silently settling downstream.
    const parsed = whishCollectStatusSchema.safeParse(data.collectStatus);
    if (!parsed.success) {
      throw new WhishError(
        `Whish returned an unrecognized collectStatus: ${String(data.collectStatus)}`,
        { collectStatus: data.collectStatus },
      );
    }
    // The live sandbox returns an EMPTY STRING (not null) for an unpaid link, so
    // normalise blank to null — otherwise we persist "" as a phone number, which
    // reads as "we have a payer" everywhere downstream (UI, CSV, search).
    const phone = data.payerPhoneNumber != null ? String(data.payerPhoneNumber).trim() : '';
    return { collectStatus: parsed.data, payerPhoneNumber: phone === '' ? null : phone };
  }

  /**
   * Real account balance for a currency. Whish supports USD and LBP (v1.4.1);
   * which of those are live for this platform is gated by WHISH_CURRENCIES, so
   * this signature deliberately does not re-narrow it to 'USD'.
   */
  async getBalance(currency: WhishCurrency): Promise<{ balance: number }> {
    const data = await this.call<{ balance: number }>(
      'GET',
      `/payment/account/balance?currency=${currency}`,
    );
    // A missing/non-numeric balance used to silently report $0.00, which reads
    // in the admin UI as "the account is empty" rather than "the call failed".
    if (typeof data?.balance !== 'number' || !Number.isFinite(data.balance)) {
      throw new WhishError('Whish did not return a balance', { currency });
    }
    return { balance: data.balance };
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      channel: this.config.get('WHISH_CHANNEL', { infer: true }),
      secret: this.config.get('WHISH_SECRET', { infer: true }),
      websiteUrl: this.config.get('WHISH_WEBSITE_URL', { infer: true }),
      'User-Agent': this.config.get('WHISH_USER_AGENT', { infer: true }),
    };
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    if (!this.isConfigured()) {
      throw new ValidationError('Whish is not configured (missing WHISH_CHANNEL / WHISH_SECRET)');
    }
    const url = `${this.config.get('WHISH_BASE_URL', { infer: true })}${path}`;

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: this.headers(),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(WHISH_TIMEOUT_MS),
      });
    } catch (err) {
      // A TIMEOUT is not a failure: the request was already in flight, so Whish
      // may well have processed it. Anything else (DNS, ECONNREFUSED, TLS) never
      // reached Whish and is a definite failure.
      const name = (err as Error | undefined)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        this.logger.warn(
          `Whish INDETERMINATE: ${method} ${path} timed out after ${WHISH_TIMEOUT_MS}ms`,
        );
        throw new WhishIndeterminateError(
          'Whish did not answer in time — the outcome is unknown, not failed',
          { path, timeoutMs: WHISH_TIMEOUT_MS },
        );
      }
      this.logger.error(`Whish request failed: ${method} ${path}`, err as Error);
      throw new WhishError('Could not reach Whish', { path });
    }

    // Checked BEFORE parsing: a 5xx often carries an HTML error page from a
    // proxy, which would otherwise surface as the "non-JSON response" error
    // below and be (mis)treated as a definite failure.
    if (res.status >= 500) {
      this.logger.warn(`Whish INDETERMINATE: ${method} ${path} returned HTTP ${res.status}`);
      throw new WhishIndeterminateError(
        `Whish returned HTTP ${res.status} — the outcome is unknown, not failed`,
        { path, httpStatus: res.status },
      );
    }

    let json: WhishEnvelope<T>;
    try {
      json = (await res.json()) as WhishEnvelope<T>;
    } catch {
      throw new WhishError(`Whish returned a non-JSON response (HTTP ${res.status})`, { path });
    }

    if (!res.ok || !json.status) {
      const code = json.code ?? undefined;
      const upstreamMessage =
        json.dialog?.message ?? code ?? `Whish call failed (HTTP ${res.status})`;
      // v1.4.4: `status:false` + `code:"500"` is PENDING, not failed — "the call
      // did not return an outcome, so the result is unknown rather than failed …
      // do not mark it failed". Reconcile by externalId instead.
      if (code === '500') {
        this.logger.warn(`Whish INDETERMINATE: ${path} returned code=500 msg=${upstreamMessage}`);
        throw new WhishIndeterminateError(
          upstreamMessage,
          { path, code, httpStatus: res.status, upstreamMessage },
          json,
        );
      }
      this.logger.warn(`Whish ${path} failed: code=${json.code} msg=${upstreamMessage}`);
      // Whish reports invalid/expired API credentials as a consumer-facing
      // "Please sign in again. You have been signed out." dialog. Relaying that
      // verbatim makes a platform misconfiguration look like the company user's
      // own app session expired, so translate auth failures into an honest
      // message. The real upstream code/message stay in the log + error details.
      // v1.4.4 documents these as `auth.session_not_exist` / `auth.session_expired`,
      // both already covered by the `auth.` prefix test below.
      const isAuthFailure =
        res.status === 401 || res.status === 403 || (code?.startsWith('auth.') ?? false);
      const message = isAuthFailure
        ? 'Whish rejected the request — the payment provider is not configured correctly (invalid or expired credentials). Please contact support.'
        : upstreamMessage;
      throw new WhishError(
        message,
        { path, code, httpStatus: res.status, upstreamMessage },
        // The raw Whish envelope: log-only, never returned to the API caller.
        json,
      );
    }

    return json.data as T;
  }
}
