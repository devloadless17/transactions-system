import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema';

// Cap every Telegram call so an unresponsive upstream can't hang the caller.
const TELEGRAM_TIMEOUT_MS = 10_000;
// Total send attempts before giving up on a transient failure.
const MAX_ATTEMPTS = 3;
// Backoff before attempt 2 and attempt 3 respectively (ms).
const RETRY_BACKOFF_MS = [500, 1500];

const FLOW_HEADING: Record<'PAYOUT' | 'LOAD', string> = {
  PAYOUT: '🟢 New PAYOUT request',
  LOAD: '🔵 New LOAD request',
};
const FLOW_ADMIN_PATH: Record<'PAYOUT' | 'LOAD', string> = {
  PAYOUT: 'payouts',
  LOAD: 'loads',
};

/** Escape the five characters that are unsafe inside Telegram HTML parse mode. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Thin, best-effort client for sending alerts to a Telegram group via the Bot
 * API. Used to ping platform admins the instant a company submits a load/payout
 * request they must action. Deliberately fire-and-forget: it NEVER throws to the
 * caller and can never block or roll back a money operation — every failure ends
 * in a log line.
 *
 * Gated by `isConfigured()`: when the bot token / chat id are unset (e.g. on
 * staging) every call is a silent no-op, so the exact same code ships to every
 * environment and only production — which sets the credentials — actually sends.
 */
@Injectable()
export class TelegramClient {
  private readonly logger = new Logger(TelegramClient.name);

  constructor(private readonly config: ConfigService<Env, true>) {}

  /** Both the bot token and target chat id must be present to send anything. */
  isConfigured(): boolean {
    return (
      !!this.config.get('TELEGRAM_BOT_TOKEN', { infer: true }) &&
      !!this.config.get('TELEGRAM_CHAT_ID', { infer: true })
    );
  }

  /** Alert admins that a company submitted a load/payout request. */
  async notifyRequest(p: {
    flow: 'PAYOUT' | 'LOAD';
    companyName: string | null;
    amount: string;
    currency: string;
    entityId: string;
  }): Promise<void> {
    if (!this.isConfigured()) return;

    const webOrigin = this.config.get('WEB_ORIGIN', { infer: true });
    const link = `${webOrigin}/admin/${FLOW_ADMIN_PATH[p.flow]}`;
    const company = escapeHtml(p.companyName?.trim() || 'A company');
    const text =
      `${FLOW_HEADING[p.flow]}\n` +
      `Company: <b>${company}</b>\n` +
      `Amount: <b>${escapeHtml(p.amount)} ${escapeHtml(p.currency)}</b>\n\n` +
      `<a href="${escapeHtml(link)}">Open in dashboard →</a>`;

    await this.send(text);
  }

  /**
   * POST the message, retrying transient failures (network/timeout, 429, 5xx) up
   * to MAX_ATTEMPTS. A 4xx (bad token/chat id) is permanent — log and stop. This
   * method swallows every error; alerting must never break the caller.
   */
  private async send(text: string): Promise<void> {
    const token = this.config.get('TELEGRAM_BOT_TOKEN', { infer: true });
    const chatId = this.config.get('TELEGRAM_CHAT_ID', { infer: true });
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const body = JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
        });
        if (res.ok) return;

        // 4xx (except 429) is a permanent misconfiguration — retrying won't help.
        const retryable = res.status === 429 || res.status >= 500;
        const detail = await res.text().catch(() => '');
        if (!retryable) {
          this.logger.error(
            `Telegram sendMessage failed permanently (HTTP ${res.status}): ${detail}`,
          );
          return;
        }
        this.logger.warn(
          `Telegram sendMessage transient failure (HTTP ${res.status}), attempt ${attempt}/${MAX_ATTEMPTS}`,
        );
      } catch (err) {
        // Network error or timeout — transient, fall through to retry.
        this.logger.warn(
          `Telegram sendMessage error, attempt ${attempt}/${MAX_ATTEMPTS}: ${(err as Error).message}`,
        );
      }

      if (attempt < MAX_ATTEMPTS) await delay(RETRY_BACKOFF_MS[attempt - 1] ?? 1500);
    }
    this.logger.error(`Telegram sendMessage gave up after ${MAX_ATTEMPTS} attempts`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
