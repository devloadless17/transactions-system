import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema';
import { DomainError, ValidationError } from '../../common/errors/domain.error';

// Cap every Whish call so an unresponsive upstream can't hang the callback
// handler or the reconciliation poller indefinitely.
const WHISH_TIMEOUT_MS = 10_000;

/** Upstream Whish failure (network error or `status: false` envelope). */
export class WhishError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('WHISH_ERROR', message, 502, details);
  }
}

// The unified Whish response envelope.
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
  externalId: number;
  successCallbackUrl: string;
  failureCallbackUrl: string;
  successRedirectUrl: string;
  failureRedirectUrl: string;
}

export type WhishCollectStatus = 'success' | 'failed' | 'pending';

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
    externalId: number;
  }): Promise<{ collectStatus: WhishCollectStatus; payerPhoneNumber: string | null }> {
    const data = await this.call<{
      collectStatus: WhishCollectStatus;
      payerPhoneNumber?: string | number | null;
    }>('POST', '/payment/collect/status', {
      currency: input.currency,
      externalId: input.externalId,
    });
    if (!data?.collectStatus) throw new WhishError('Whish status response missing collectStatus');
    return {
      collectStatus: data.collectStatus,
      payerPhoneNumber: data.payerPhoneNumber != null ? String(data.payerPhoneNumber) : null,
    };
  }

  /** Real account balance for a currency (USD only). */
  async getBalance(currency: 'USD'): Promise<{ balance: number }> {
    const data = await this.call<{ balance: number }>(
      'GET',
      `/payment/account/balance?currency=${currency}`,
    );
    return { balance: data?.balance ?? 0 };
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
      this.logger.error(`Whish request failed: ${method} ${path}`, err as Error);
      throw new WhishError('Could not reach Whish', { path });
    }

    let json: WhishEnvelope<T>;
    try {
      json = (await res.json()) as WhishEnvelope<T>;
    } catch {
      throw new WhishError(`Whish returned a non-JSON response (HTTP ${res.status})`, { path });
    }

    if (!res.ok || !json.status) {
      const msg = json.dialog?.message ?? json.code ?? `Whish call failed (HTTP ${res.status})`;
      this.logger.warn(`Whish ${path} failed: code=${json.code} msg=${msg}`);
      throw new WhishError(msg, { path, code: json.code ?? undefined, httpStatus: res.status });
    }

    return json.data as T;
  }
}
