import { describe, expect, it, vi } from 'vitest';
import type { CrmEventPayload } from '@app/shared';
import type { PrismaService } from '../../database/prisma.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { CrmDemoInboxService, isStaleEvent } from './crm-demo-inbox.service';

/**
 * CRM deliveries are at-least-once and NOT ordered: each event retries on its
 * own schedule, so an older event can arrive after a newer one for the same
 * reference. The reference receiver must never let that move a record backwards.
 */
const event = (name: string, status: string, sentAt: string): CrmEventPayload =>
  ({
    event: name,
    reference: 'withdrawal:w-1',
    sentAt,
    withdrawal: { id: 'w-1', status },
  }) as unknown as CrmEventPayload;

const PENDING = event('withdrawal.pending', 'PENDING', '2026-10-08T10:00:00.000Z');
const COMPLETED = event('withdrawal.completed', 'COMPLETED', '2026-10-08T10:00:15.000Z');

describe('isStaleEvent', () => {
  it('an older event is stale; a newer one is not', () => {
    expect(isStaleEvent(PENDING, COMPLETED)).toBe(true);
    expect(isStaleEvent(COMPLETED, PENDING)).toBe(false);
  });

  it('a re-delivery of the same event (same sentAt) is applied again — it is identical', () => {
    expect(isStaleEvent(COMPLETED, COMPLETED)).toBe(false);
  });

  it('nothing stored yet, or an unparseable timestamp, never drops an event', () => {
    expect(isStaleEvent(PENDING, null)).toBe(false);
    expect(isStaleEvent({ sentAt: 'not-a-date' }, COMPLETED)).toBe(false);
    expect(isStaleEvent(PENDING, { sentAt: '' })).toBe(false);
  });
});

describe('CrmDemoInboxService.receive', () => {
  function setup(stored: CrmEventPayload | null) {
    const upsert = vi.fn().mockResolvedValue({});
    const tx = {
      crmDemoEvent: {
        findUnique: vi.fn().mockResolvedValue(stored ? { payload: stored } : null),
        upsert,
        findMany: vi.fn().mockResolvedValue([]),
        deleteMany: vi.fn(),
      },
    };
    const prisma = {
      runAsAdmin: vi.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
    } as unknown as PrismaService;
    const company = vi.fn();
    const svc = new CrmDemoInboxService(prisma, { company } as unknown as RealtimeService);
    return { svc, upsert, company };
  }

  it('a late retry of `pending` does NOT turn a completed withdrawal back to PENDING', async () => {
    const { svc, upsert, company } = setup(COMPLETED);
    await svc.receive('c-1', PENDING);
    expect(upsert).not.toHaveBeenCalled();
    expect(company).not.toHaveBeenCalled();
  });

  it('the normal order — pending, then completed — moves the record forward', async () => {
    const { svc, upsert } = setup(PENDING);
    await svc.receive('c-1', COMPLETED);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0]![0].update).toMatchObject({
      eventType: 'withdrawal.completed',
      status: 'COMPLETED',
    });
  });

  it('the first event for a reference is stored', async () => {
    const { svc, upsert, company } = setup(null);
    await svc.receive('c-1', PENDING);
    expect(upsert.mock.calls[0]![0].create).toMatchObject({
      reference: 'withdrawal:w-1',
      eventType: 'withdrawal.pending',
      status: 'PENDING',
    });
    expect(company).toHaveBeenCalledWith('c-1', ['crm']);
  });
});
