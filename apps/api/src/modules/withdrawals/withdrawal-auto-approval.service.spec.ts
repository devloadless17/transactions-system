import { describe, expect, it, vi } from 'vitest';
import { WithdrawalAutoApprovalService } from './withdrawal-auto-approval.service';

// Safety guarantee under test: when auto-approval is OFF (or the toggle is flipped
// OFF mid-run), the processor must NEVER claim a withdrawal or send a transfer.
// We mock the four collaborators and assert the transfer-initiating calls
// (claimForProcessing / sendTransfer) are never reached.

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

function build(opts: {
  state: Record<string, unknown>;
  isEnabled?: boolean;
  w2wEnabled?: boolean;
  sessionConfigured?: boolean;
  candidates?: unknown[];
}) {
  const withdrawals = {
    findStuckProcessing: vi.fn().mockResolvedValue([]),
    findAutoApprovalCandidates: vi.fn().mockResolvedValue(opts.candidates ?? []),
    claimForProcessing: vi.fn().mockResolvedValue(true),
  };
  const config = {
    getState: vi.fn().mockResolvedValue(opts.state),
    isEnabled: vi.fn().mockResolvedValue(opts.isEnabled ?? true),
    maybeAutoResume: vi.fn().mockResolvedValue(false),
  };
  const transfers = {
    isW2WEnabled: vi.fn().mockReturnValue(opts.w2wEnabled ?? true),
    sessionStatus: vi.fn().mockResolvedValue({ configured: opts.sessionConfigured ?? true }),
    sendTransfer: vi.fn().mockResolvedValue({ status: 'SUCCESS', reference: 'wt_x', traceId: 't' }),
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
  return { service, withdrawals, transfers, config };
}

// tick() is private; invoke it directly for the unit test.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const runTick = (s: WithdrawalAutoApprovalService) => (s as any).tick();

const candidate = {
  id: 'w1',
  companyId: 'c1',
  netAmount: { toString: () => '20' },
  currency: 'USD',
  payoutDetails: { recipientPhone: '71178866' },
};

describe('WithdrawalAutoApprovalService — disabled never transfers', () => {
  it('does nothing when the toggle is OFF', async () => {
    const { service, withdrawals, transfers } = build({
      state: makeState({ enabled: false, enabledAt: null }),
    });
    await runTick(service);
    expect(withdrawals.findStuckProcessing).not.toHaveBeenCalled();
    expect(withdrawals.findAutoApprovalCandidates).not.toHaveBeenCalled();
    expect(withdrawals.claimForProcessing).not.toHaveBeenCalled();
    expect(transfers.sendTransfer).not.toHaveBeenCalled();
  });

  it('does nothing when enabled but enabledAt is missing', async () => {
    const { service, withdrawals, transfers } = build({
      state: makeState({ enabled: true, enabledAt: null }),
    });
    await runTick(service);
    expect(withdrawals.findAutoApprovalCandidates).not.toHaveBeenCalled();
    expect(transfers.sendTransfer).not.toHaveBeenCalled();
  });

  it('does not transfer when WHISH_W2W_ENABLED is false', async () => {
    const { service, withdrawals, transfers } = build({
      state: makeState(),
      w2wEnabled: false,
    });
    await runTick(service);
    expect(withdrawals.findAutoApprovalCandidates).not.toHaveBeenCalled();
    expect(transfers.sendTransfer).not.toHaveBeenCalled();
  });

  it('stops before claiming if the toggle is flipped OFF mid-run', async () => {
    const { service, withdrawals, transfers } = build({
      state: makeState(), // enabled at tick start (passes the top gate)
      isEnabled: false, // ...but the per-item re-check sees it OFF
      candidates: [candidate],
    });
    await runTick(service);
    // The candidate query ran, but no claim and no transfer happened.
    expect(withdrawals.findAutoApprovalCandidates).toHaveBeenCalled();
    expect(withdrawals.claimForProcessing).not.toHaveBeenCalled();
    expect(transfers.sendTransfer).not.toHaveBeenCalled();
  });
});
