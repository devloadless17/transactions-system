import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { crmSignature } from './crm-delivery.service';

describe('crmSignature (outbound CRM webhook signature)', () => {
  it('is HMAC-SHA256 over `${timestamp}.${body}`, formatted t=<ts>,sha256=<hex>', () => {
    const secret = 'tsk_AB12CD34_deadbeef';
    const ts = '1700000000';
    const body = '{"event":"transaction.completed","reference":"whish:42"}';
    const expected = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
    expect(crmSignature(secret, ts, body)).toBe(`t=${ts},sha256=${expected}`);
  });

  it('changes when the body changes (tamper detection)', () => {
    expect(crmSignature('k', '1', '{"a":1}')).not.toBe(crmSignature('k', '1', '{"a":2}'));
  });

  it('changes when the timestamp changes (replay binding)', () => {
    expect(crmSignature('k', '1', '{}')).not.toBe(crmSignature('k', '2', '{}'));
  });

  it('changes with the key (only holders of the CRM key can forge it)', () => {
    expect(crmSignature('k1', '1', '{}')).not.toBe(crmSignature('k2', '1', '{}'));
  });
});
