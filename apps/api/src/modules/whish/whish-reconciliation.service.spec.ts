import { describe, expect, it, vi } from 'vitest';
import { WhishReconciliationService } from './whish-reconciliation.service';

/**
 * One Whish poller at a time across instances (a blue/green deploy runs two
 * API versions side by side): the poll runs only holding the lease, and a run
 * that loses it stops between links. The lease SQL itself is proven against
 * Postgres in test/integration/job-leases.int-spec.ts.
 */
function build(opts: { leaseTaken?: boolean } = {}) {
  const lease = { held: true, confirm: vi.fn(async () => true) };
  const leases = {
    runExclusive: vi.fn(
      async (_name: string, _ttl: number, fn: (l: typeof lease) => Promise<unknown>) =>
        opts.leaseTaken ? { ran: false } : { ran: true, value: await fn(lease) },
    ),
  };
  const payments = {
    reconcileStalePayments: vi.fn(async (_o: { shouldStop: () => boolean }) => ({
      checked: 0,
      timedOut: 0,
    })),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new WhishReconciliationService(payments as any, leases as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tick = () => (service as any).tick() as Promise<void>;
  return { service, tick, payments, leases, lease };
}

describe('WhishReconciliationService — one poller across instances', () => {
  it('polls only while holding the lease', async () => {
    const { tick, payments, leases } = build();
    await tick();
    expect(leases.runExclusive).toHaveBeenCalledWith(
      'whish-reconciliation',
      60_000,
      expect.any(Function),
    );
    expect(payments.reconcileStalePayments).toHaveBeenCalledOnce();
  });

  it('skips the poll while another instance holds the lease', async () => {
    const { tick, payments } = build({ leaseTaken: true });
    await tick();
    expect(payments.reconcileStalePayments).not.toHaveBeenCalled();
  });

  it('a run stops between links once its lease is lost, or on shutdown', async () => {
    const { service, tick, payments, lease } = build();
    let shouldStop = () => false;
    payments.reconcileStalePayments.mockImplementationOnce(async (o) => {
      shouldStop = o.shouldStop;
      return { checked: 0, timedOut: 0 };
    });
    await tick();
    expect(shouldStop()).toBe(false);
    lease.held = false; // a renewal failed: the lease may be someone else's now
    expect(shouldStop()).toBe(true);
    lease.held = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).stopping = true;
    expect(shouldStop()).toBe(true);
  });
});
