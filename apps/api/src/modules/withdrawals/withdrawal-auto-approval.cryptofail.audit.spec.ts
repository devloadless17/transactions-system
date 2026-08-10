import { describe, expect, it, vi } from 'vitest';
import { WithdrawalAutoApprovalService } from './withdrawal-auto-approval.service';
import { ValidationError } from '../../common/errors/domain.error';

// A credential-DECRYPTION failure (wrong WHISH_W2W_ENC_KEY) happens BEFORE submit()
// — money definitively did NOT move. WhishTransfersService catches the underlying
// W2WCryptoError and surfaces it as a ValidationError (see
// whish-transfers.service.audit.spec.ts). This pins the ORCHESTRATOR half: a
// ValidationError from sendTransfer must revert the row to manual (invariant 3/6),
// NOT hold it PROCESSING+needsReconcile or burn a circuit-breaker failure.

function makeState(over: Record<string, unknown> = {}) {
  return {
    enabled: true,
    enabledAt: new Date('2026-01-01T00:00:00Z'),
    holdSeconds: 30,
    maxAutoApproveAmount: '500',
    circuitBreakerTrippedAt: null,
    consecutiveFailures: 0,
    failureThreshold: 3,
    updatedAt: null,
    ...over,
  };
}

const candidate = {
  id: 'w1',
  companyId: 'c1',
  netAmount: { toString: () => '20' },
  currency: 'USD',
  payoutDetails: { recipientPhone: '71505894' },
};

function build() {
  const withdrawals = {
    findStuckProcessing: vi.fn().mockResolvedValue([]),
    findAutoApprovalCandidates: vi.fn().mockResolvedValue([candidate]),
    claimForProcessing: vi.fn().mockResolvedValue(true),
    revertFromProcessing: vi.fn().mockResolvedValue(undefined),
    setAutoMeta: vi.fn().mockResolvedValue(undefined),
    approve: vi.fn().mockResolvedValue(undefined),
  };
  const config = {
    simulationMode: false,
    getState: vi.fn().mockResolvedValue(makeState()),
    isEnabled: vi.fn().mockResolvedValue(true),
    maybeAutoResume: vi.fn().mockResolvedValue(false),
    recordFailure: vi.fn().mockResolvedValue(undefined),
    recordSuccess: vi.fn().mockResolvedValue(undefined),
    trip: vi.fn().mockResolvedValue(undefined),
  };
  const transfers = {
    isW2WEnabled: vi.fn().mockReturnValue(true),
    sessionStatus: vi.fn().mockResolvedValue({ configured: true }),
    // What the FIXED WhishTransfersService throws on a decryption failure:
    sendTransfer: vi
      .fn()
      .mockRejectedValue(
        new ValidationError('Whish W2W session credentials could not be decrypted'),
      ),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const service = new WithdrawalAutoApprovalService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    withdrawals as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    config as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    transfers as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    audit as any,
  );
  return { service, withdrawals, config };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const runTick = (s: WithdrawalAutoApprovalService) => (s as any).tick();

describe('auto-approval: decryption-failure (ValidationError) classification', () => {
  it('reverts the row to manual (terminal FAILED) and does NOT hold needsReconcile or burn a breaker failure', async () => {
    const { service, withdrawals, config } = build();
    await runTick(service);

    // money did NOT move → revert to manual, marked terminal.
    expect(withdrawals.revertFromProcessing).toHaveBeenCalledWith(
      candidate.id,
      candidate.companyId,
      expect.objectContaining({ status: 'FAILED', terminal: true }),
    );
    // It is NOT treated as the ambiguous "money MAY have moved" branch:
    expect(withdrawals.setAutoMeta).not.toHaveBeenCalled();
    // ...and a config error must not count against the circuit breaker.
    expect(config.recordFailure).not.toHaveBeenCalled();
  });

  it('a session_decrypt_failed ValidationError (details.code) is FLEET-WIDE: reverts, TRIPS the breaker, and stops the tick', async () => {
    const { service, withdrawals, config } = build();
    // Two candidates queued: the tick must stop after the FIRST decrypt failure
    // instead of burning the whole queue row-by-row to manual.
    const second = { ...candidate, id: 'w2' };
    withdrawals.findAutoApprovalCandidates.mockResolvedValue([candidate, second]);
    (service as unknown as { transfers: { sendTransfer: ReturnType<typeof vi.fn> } })[
      'transfers'
    ].sendTransfer = vi.fn().mockRejectedValue(
      new ValidationError('Whish W2W session credentials could not be decrypted', {
        code: 'session_decrypt_failed',
      }),
    );
    await runTick(service);

    // Row reverted to manual (money did not move)…
    expect(withdrawals.revertFromProcessing).toHaveBeenCalledWith(
      candidate.id,
      candidate.companyId,
      expect.objectContaining({ status: 'FAILED', terminal: true }),
    );
    // …the breaker trips loudly (one paused-feature signal, not N silent rows)…
    expect(config.trip).toHaveBeenCalledWith('session_decrypt_failed');
    // …and the tick stopped: the second candidate was never claimed.
    expect(withdrawals.claimForProcessing).toHaveBeenCalledTimes(1);
  });
});
