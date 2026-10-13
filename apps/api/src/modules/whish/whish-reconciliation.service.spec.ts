import { afterEach, describe, expect, it, vi } from 'vitest';
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
      more: false,
    })),
    // When the next link is due (ms since epoch), or null when none is open.
    nextPollDueAt: vi.fn(async (): Promise<number | null> => null),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new WhishReconciliationService(payments as any, leases as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tick = () => (service as any).tick(true) as Promise<void>;
  return { service, tick, payments, leases, lease };
}

afterEach(() => vi.useRealTimers());

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
      return { checked: 0, timedOut: 0, more: false };
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

describe('WhishReconciliationService — each link is checked when it is due', () => {
  it('comes back at the moment the next link is due, not at the next heartbeat', async () => {
    vi.useFakeTimers();
    const { service, tick, payments } = build();
    payments.nextPollDueAt.mockResolvedValueOnce(Date.now() + 20_000);

    await tick();
    expect(payments.reconcileStalePayments).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(19_900); // not due yet
    expect(payments.reconcileStalePayments).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(400); // just past the due moment
    expect(payments.reconcileStalePayments).toHaveBeenCalledTimes(2);
    service.onModuleDestroy();
  });

  it('sets no timer when nothing is open, or when the heartbeat comes first', async () => {
    vi.useFakeTimers();
    const { service, tick, payments } = build();

    await tick(); // nextPollDueAt → null: no link is open
    payments.nextPollDueAt.mockResolvedValueOnce(Date.now() + 5 * 60_000);
    await tick(); // the next link is due in 5 minutes: the heartbeat looks again

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(payments.reconcileStalePayments).toHaveBeenCalledTimes(2); // only our two ticks
    service.onModuleDestroy();
  });

  it('a full batch is followed by the next at once — a backlog never waits a minute per batch', async () => {
    const { tick, payments } = build();
    payments.reconcileStalePayments
      .mockResolvedValueOnce({ checked: 250, timedOut: 0, more: true })
      .mockResolvedValueOnce({ checked: 250, timedOut: 0, more: true })
      .mockResolvedValueOnce({ checked: 40, timedOut: 0, more: false });

    await tick();

    expect(payments.reconcileStalePayments).toHaveBeenCalledTimes(3);
    expect(payments.nextPollDueAt).toHaveBeenCalledOnce(); // once the backlog is gone
  });

  it('a due link a pass could not move on is retried after a second, never in a tight loop', async () => {
    vi.useFakeTimers();
    const { service, tick, payments } = build();
    payments.nextPollDueAt.mockResolvedValueOnce(Date.now() - 30_000); // already due

    await tick();
    await vi.advanceTimersByTimeAsync(900);
    expect(payments.reconcileStalePayments).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(payments.reconcileStalePayments).toHaveBeenCalledTimes(2);
    service.onModuleDestroy();
  });

  it('sets no wake-up while another instance is the poller', async () => {
    vi.useFakeTimers();
    const { tick, payments } = build({ leaseTaken: true });
    await tick();
    expect(payments.nextPollDueAt).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a shutdown that begins while the next due moment is being read sets no wake-up', async () => {
    vi.useFakeTimers();
    const { service, tick, payments } = build();
    payments.nextPollDueAt.mockImplementationOnce(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any).stopping = true;
      service.onModuleDestroy(); // what the registered stop does
      return Date.now() + 5_000;
    });

    await tick();

    expect(vi.getTimerCount()).toBe(0);
    // …and nothing starts once the shutdown has begun.
    await tick();
    expect(payments.reconcileStalePayments).toHaveBeenCalledOnce();
  });

  it('a wake-up that lands while a pass is running is dropped, not queued', async () => {
    const { service, tick, payments } = build();
    let release!: () => void;
    payments.reconcileStalePayments.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ checked: 1, timedOut: 0, more: false });
        }),
    );

    const running = tick();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (service as any).tick(); // a wake-up fires mid-pass
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (service as any).tick();
    await Promise.resolve();
    release();
    await running;

    expect(payments.reconcileStalePayments).toHaveBeenCalledOnce();
    expect(payments.nextPollDueAt).toHaveBeenCalledOnce(); // the pass itself sets the next one
    service.onModuleDestroy();
  });

  it('a shutdown ends a backlog run and sets no further wake-up', async () => {
    vi.useFakeTimers();
    const { service, tick, payments } = build();
    payments.reconcileStalePayments.mockImplementation(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any).stopping = true; // the stop arrives during the first batch
      return { checked: 250, timedOut: 0, more: true };
    });

    await tick();

    expect(payments.reconcileStalePayments).toHaveBeenCalledOnce();
    expect(payments.nextPollDueAt).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
