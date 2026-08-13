import { describe, expect, it } from 'vitest';
import {
  createWhishPaymentSchema,
  setWhishRedirectConfigSchema,
  setWhishWebhookSchema,
} from './whish';

/**
 * Payer redirect URLs must be reachable by someone other than the machine that
 * saved them.
 *
 * This exists because of a real incident: a company saved
 * `http://localhost:5173/client/deposit` (their Vite dev server) as their Whish
 * redirect. The save succeeded, and every later attempt to create a payment link
 * failed with "Whish returned a non-JSON response (HTTP 403)" — Whish answers a
 * bare HTML 403 for loopback URLs. The company had no way to connect that toast
 * back to a setting they had changed days earlier.
 *
 * The boundaries below were measured against the live Whish sandbox, not assumed.
 */

const cfg = (u: string) =>
  setWhishRedirectConfigSchema.safeParse({ successUrl: u, failureUrl: u }).success;

describe('payer redirect URLs must be publicly reachable', () => {
  // Whish itself 403s these — verified live.
  it.each([
    'http://localhost:5173/client/deposit',
    'https://localhost/x',
    'http://127.0.0.1:5173/x',
  ])('rejects %s (Whish returns a bare 403 for it)', (u) => expect(cfg(u)).toBe(false));

  // Whish ACCEPTS these, but a payer's phone cannot reach them either, so we
  // deliberately go one step further and refuse them at save time.
  it.each(['http://[::1]:5173/x', 'http://0.0.0.0:5173/x', 'http://foo.localhost/x'])(
    'rejects %s even though Whish would accept it',
    (u) => expect(cfg(u)).toBe(false),
  );

  // NOT rejected: Whish accepts them and an intranet flow is conceivable. Being
  // stricter than the payment provider without cause is its own failure mode.
  it.each([
    'http://192.168.1.10:3000/x',
    'http://10.0.0.5/x',
    'http://example.com/done',
    'https://app.example.com/done',
  ])('accepts %s', (u) => expect(cfg(u)).toBe(true));

  it('says what to do about it, not just that it is wrong', () => {
    const res = setWhishRedirectConfigSchema.safeParse({
      successUrl: 'http://localhost:5173/x',
      failureUrl: null,
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0]!.message).toMatch(/publicly reachable/);
      expect(res.error.issues[0]!.message).toMatch(/leave this empty/i);
    }
  });

  it('applies to a PER-LINK override too, not only the saved default', () => {
    const body = { amount: '25.00', currency: 'USD' as const, invoice: 'x' };
    expect(createWhishPaymentSchema.safeParse(body).success).toBe(true);
    expect(
      createWhishPaymentSchema.safeParse({ ...body, successRedirectUrl: 'http://localhost:5173/x' })
        .success,
    ).toBe(false);
  });

  it('applies to the outbound webhook target (same SSRF shape)', () => {
    expect(setWhishWebhookSchema.safeParse({ url: 'http://127.0.0.1:9000/hook' }).success).toBe(
      false,
    );
    expect(setWhishWebhookSchema.safeParse({ url: 'https://crm.example.com/hook' }).success).toBe(
      true,
    );
  });

  it('still rejects a non-http scheme and keeps clearing to null possible', () => {
    expect(cfg('javascript:alert(1)')).toBe(false);
    expect(
      setWhishRedirectConfigSchema.safeParse({ successUrl: null, failureUrl: null }).success,
    ).toBe(true);
  });
});
