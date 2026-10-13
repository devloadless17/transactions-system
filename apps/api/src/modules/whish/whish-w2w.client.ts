import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema';
import { DomainError } from '../../common/errors/domain.error';
import { UPSTREAM_ERROR_STATUS } from './whish.client';
import type { ResolvedW2WSession } from './whish-session.store';

// Cap every W2W call so an unresponsive upstream can't hang the request handler.
const W2W_TIMEOUT_MS = 15_000;

// Whish's transfer "application" id and the field ids of its submission form,
// captured from the live consumer app. Pinned as constants — if Whish changes
// them, a transfer would silently misroute, so they must be reviewed on change.
const APPLICATION_ID = '20';
const FIELD_PHONE = '137';
const FIELD_TRANSFER_AMOUNT = '138';
const FIELD_RECEIVABLE_AMOUNT = '139';
const FIELD_NOTE = '140';
const FIELD_SCAM_DISCLAIMER = '1316';
const FIELD_CANCEL_DISCLAIMER = '1059';
const SCAM_DISCLAIMER = 'Be careful, if you fall victim to a scam you may not get your money back.';
const CANCEL_DISCLAIMER = 'Cancellation of this transaction requires Receiver’s consent';

// Genuine session/credential `auth.*` codes — the caller's session is bad, not the
// request payload. Deliberately does NOT match input-validation codes Whish also
// namespaces under `auth.` (e.g. `auth.wrong_phone_format`, `auth.wrong_amount`).
// 401/403 and the "sign in again / signed out / session expired" dialog regex remain
// the primary session signals; this only catches session codes returned as HTTP 200.
const SESSION_AUTH_CODE =
  /^auth\.(session|token|login|sign_?in|signed?_?out|expired|unauthor|forbidden|invalid_session|not_?authenticated|no_?session|revoked)/i;

/**
 * Raised when Whish rejects the captured session as expired/invalid. 503 (not
 * 502) so the JSON body survives Cloudflare — see UPSTREAM_ERROR_STATUS.
 */
export class WhishSessionExpiredError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('WHISH_SESSION_EXPIRED', message, UPSTREAM_ERROR_STATUS, details);
  }
}

export interface W2WSubmitInput {
  /** Bare msisdn (digits only). */
  phone: string;
  /** Decimal amount string (already validated). */
  amount: string;
  session: ResolvedW2WSession;
}

/**
 * Outcome of one submit call. Money-bearing outcomes are returned (not thrown)
 * so the service can record them; only an expired session throws.
 *   success     — status:true (money moved)
 *   failed      — status:false business/validation failure (money did NOT move)
 *   unreachable — network/timeout/5xx/non-JSON: money MAY have moved → UNKNOWN
 */
export type W2WSubmitResult =
  | {
      outcome: 'success' | 'failed';
      httpStatus: number;
      traceId: string | null;
      // The `sessionCounter` Whish echoes in the response header — its view of the
      // NEXT counter to send. We sync our stored counter to this so a session
      // shared with the phone self-corrects instead of drifting. null if absent.
      nextCounter: number | null;
      code: string | null;
      message: string | null;
      response: unknown;
    }
  | { outcome: 'unreachable'; detail: string };

interface W2WEnvelope {
  status?: boolean;
  code?: string | null;
  dialog?: { title?: string | null; message?: string | null } | null;
}

/**
 * Thin client over Whish's CONSUMER-app transfer endpoint
 * (POST {WHISH_W2W_BASE_URL}/application/submit). Builds the captured
 * session headers + fresh timestamps + the per-request counter, posts the
 * exact application-field body, and classifies the reply. The raw request/
 * response are returned to the caller (for the admin log) with the session
 * headers redacted — token/uid/sessionid are NEVER surfaced.
 */
@Injectable()
export class WhishW2WClient {
  private readonly logger = new Logger(WhishW2WClient.name);

  constructor(private readonly config: ConfigService<Env, true>) {}

  isEnabled(): boolean {
    return this.config.get('WHISH_W2W_ENABLED', { infer: true });
  }

  async submit(input: W2WSubmitInput): Promise<W2WSubmitResult> {
    const url = `${this.config.get('WHISH_W2W_BASE_URL', { infer: true })}/application/submit`;
    const amount = input.amount; // 2dp string, formatted by the service
    const body = this.buildBody(input.phone, amount);
    const headers = this.buildHeaders(input.session);

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(W2W_TIMEOUT_MS),
      });
    } catch (err) {
      // Network error or timeout — we never saw a response, so the transfer is
      // ambiguous (money may or may not have moved). Surface as unreachable.
      this.logger.error(`Whish W2W request failed to reach upstream`, err as Error);
      return { outcome: 'unreachable', detail: (err as Error).message || 'request failed' };
    }

    const traceId = res.headers.get('x-trace-id');

    // 5xx: the call reached Whish but it errored server-side — still ambiguous.
    if (res.status >= 500) {
      this.logger.warn(`Whish W2W returned HTTP ${res.status} — treating as ambiguous`);
      return { outcome: 'unreachable', detail: `upstream HTTP ${res.status}` };
    }

    let json: W2WEnvelope;
    try {
      json = (await res.json()) as W2WEnvelope;
    } catch {
      // 2xx/4xx with an unparseable body — can't confirm the outcome.
      return { outcome: 'unreachable', detail: `non-JSON response (HTTP ${res.status})` };
    }

    const code = json.code ?? null;
    const message = json.dialog?.message ?? null;
    const nextCounter = this.parseCounter(res.headers.get('sessionCounter'));

    // Expired/invalid session — Whish answers 401/403 or a "signed out" dialog.
    if (this.isAuthFailure(res.status, code, message)) {
      this.logger.warn(`Whish W2W auth failure: code=${code} msg=${message ?? ''}`);
      throw new WhishSessionExpiredError(
        'The Whish session has expired or is invalid. A SUPER_ADMIN must re-capture and update the W2W session credentials before transfers can resume.',
        { code, httpStatus: res.status, traceId },
      );
    }

    const outcome: 'success' | 'failed' = res.ok && json.status === true ? 'success' : 'failed';
    return { outcome, httpStatus: res.status, traceId, nextCounter, code, message, response: json };
  }

  private parseCounter(raw: string | null): number | null {
    if (raw == null) return null;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  }

  /** The non-secret request body, safe to persist in the admin log. */
  buildRedactedRequest(input: { phone: string; amount: string }): unknown {
    return this.buildBody(input.phone, input.amount);
  }

  private isAuthFailure(status: number, code: string | null, message: string | null): boolean {
    if (status === 401 || status === 403) return true;
    // Only GENUINE session/credential codes count as an auth outage. Whish reuses
    // the `auth.` namespace for per-request field validation too (e.g.
    // `auth.wrong_phone_format` for a malformed recipient msisdn) — those are clean
    // business failures for a single transfer, NOT a session expiry. Treating them
    // as auth failures would wrongly trip the circuit breaker (pausing the whole
    // withdrawal queue) and misdirect the operator to re-capture a healthy session,
    // while discarding the real Whish response. So we match session semantics only
    // and let everything else fall through to a normal `failed` outcome (which
    // persists the full envelope and surfaces the real message).
    if (code != null && SESSION_AUTH_CODE.test(code)) return true;
    return /sign(ed)? ?in again|signed out|session.*expired|unauthor/i.test(message ?? '');
  }

  private buildBody(phone: string, amount: string) {
    return {
      creditCardId: -1,
      fetchPrice: false,
      deletedImages: [],
      creditCardSecurityCode: null,
      confirmation: 'app',
      popupDialogChoices: null,
      applicationId: APPLICATION_ID,
      applicationFieldSubmission: [
        {
          stringValue: phone,
          fieldId: FIELD_PHONE,
          fieldIdentifier: 'phone',
          imageValues: [],
          stringText: null,
        },
        {
          stringValue: amount,
          fieldId: FIELD_TRANSFER_AMOUNT,
          fieldIdentifier: 'transferAmount',
          imageValues: [],
          stringText: null,
        },
        {
          // Empty note — we don't send our reference (or anything) to Whish; the
          // reference lives only in our own whish_transfers row. Matches the real app.
          stringValue: '',
          fieldId: FIELD_NOTE,
          fieldIdentifier: 'note',
          imageValues: [],
          stringText: null,
        },
        {
          stringValue: amount,
          fieldId: FIELD_RECEIVABLE_AMOUNT,
          fieldIdentifier: 'receivableAmount',
          imageValues: [],
          stringText: null,
        },
        {
          stringValue: SCAM_DISCLAIMER,
          fieldId: FIELD_SCAM_DISCLAIMER,
          fieldIdentifier: '',
          imageValues: [],
          stringText: null,
        },
        {
          stringValue: CANCEL_DISCLAIMER,
          fieldId: FIELD_CANCEL_DISCLAIMER,
          fieldIdentifier: '',
          imageValues: [],
          stringText: null,
        },
      ],
      externalPayment: false,
      urlDataId: null,
      bankAccountId: -1,
      optionId: null,
      recaptchaToken: null,
      price: null,
    };
  }

  private buildHeaders(s: ResolvedW2WSession): Record<string, string> {
    const ts = String(Date.now());
    return {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
      language: this.config.get('WHISH_W2W_LANGUAGE', { infer: true }),
      timezone: this.config.get('WHISH_W2W_TIMEZONE', { infer: true }),
      theme: this.config.get('WHISH_W2W_THEME', { infer: true }),
      'User-Agent': s.userAgent,
      operatingSystem: s.operatingSystem,
      osVersion: s.osVersion,
      itelVersion: s.itelVersion,
      deviceId: s.deviceId,
      serverid: s.serverId,
      token: s.token,
      uid: s.uid,
      sessionid: s.sessionId,
      sessionCounter: String(s.sessionCounter),
      timestamp: ts,
      adjustedTimestamp: ts,
    };
  }
}
