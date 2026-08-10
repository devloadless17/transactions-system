import { describe, expect, it, vi } from 'vitest';
import { WithdrawalAutoApprovalService } from './withdrawal-auto-approval.service';
import { ValidationError } from '../../common/errors/domain.error';
import { WhishSessionExpiredError } from '../whish/whish-w2w.client';

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
  simulate?: boolean;
}) {
  const withdrawals = {
    findStuckProcessing: vi.fn().mockResolvedValue([]),
    findAutoApprovalCandidates: vi.fn().mockResolvedValue(opts.candidates ?? []),
    claimForProcessing: vi.fn().mockResolvedValue(true),
    revertFromProcessing: vi.fn().mockResolvedValue(undefined),
    setAutoMeta: vi.fn().mockResolvedValue(undefined),
    approve: vi.fn().mockResolvedValue(undefined),
  };
  const config = {
    simulationMode: opts.simulate ?? false,
    getState: vi.fn().mockResolvedValue(opts.state),
    isEnabled: vi.fn().mockResolvedValue(opts.isEnabled ?? true),
    maybeAutoResume: vi.fn().mockResolvedValue(false),
    recordFailure: vi.fn().mockResolvedValue(undefined),
    recordSuccess: vi.fn().mockResolvedValue(undefined),
    trip: vi.fn().mockResolvedValue(undefined),
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
  return { service, withdrawals, transfers, config, audit };
}

// tick() is private; invoke it directly for the unit test.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const runTick = (s: WithdrawalAutoApprovalService) => (s as any).tick();

const candidate = {
  id: 'w1',
  companyId: 'c1',
  netAmount: { toString: () => '20' },
  currency: 'USD',
  payoutDetails: { recipientPhone: '71505894' },
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

describe('WithdrawalAutoApprovalService — error handling never double-pays', () => {
  it('an UNEXPECTED error (may be post-transfer) holds the row for reconcile, never reverts', async () => {
    const { service, withdrawals, config, transfers } = build({
      state: makeState(),
      candidates: [candidate],
    });
    transfers.sendTransfer.mockRejectedValue(new Error('db hiccup after the call'));
    await runTick(service);
    // Money may have moved → flag needsReconcile, keep PROCESSING (no revert).
    expect(withdrawals.setAutoMeta).toHaveBeenCalledWith(
      candidate.id,
      candidate.companyId,
      expect.objectContaining({ needsReconcile: true }),
    );
    expect(withdrawals.revertFromProcessing).not.toHaveBeenCalled();
    expect(config.recordFailure).toHaveBeenCalled();
  });

  it('on SUCCESS settles whole-dollar AND past any receivable (floorWhole + skipReceivableBlock)', async () => {
    const { service, withdrawals, transfers } = build({
      state: makeState(),
      candidates: [candidate],
    });
    transfers.sendTransfer.mockResolvedValue({
      status: 'SUCCESS',
      reference: 'wt_x',
      traceId: 't',
    });
    await runTick(service);
    // The money already left → settle must floor to whole dollars and must not be
    // blocked by a receivable that appeared after the transfer.
    expect(withdrawals.approve).toHaveBeenCalledWith(
      candidate.id,
      null,
      expect.objectContaining({ externalReference: 'wt_x' }),
      expect.objectContaining({ floorWhole: true, skipReceivableBlock: true }),
    );
  });

  it('a pre-call ValidationError (money did NOT move) reverts to manual', async () => {
    const { service, withdrawals, transfers } = build({
      state: makeState(),
      candidates: [candidate],
    });
    transfers.sendTransfer.mockRejectedValue(new ValidationError('bad amount'));
    await runTick(service);
    expect(withdrawals.revertFromProcessing).toHaveBeenCalledWith(
      candidate.id,
      candidate.companyId,
      expect.objectContaining({ status: 'FAILED', terminal: true }),
    );
    expect(withdrawals.setAutoMeta).not.toHaveBeenCalled();
  });
});

describe('WithdrawalAutoApprovalService — transfer-outcome branches', () => {
  it('(a) WhishSessionExpiredError reverts to manual, trips the breaker, and stops the tick', async () => {
    const { service, withdrawals, config, transfers } = build({
      state: makeState(),
      candidates: [candidate],
    });
    transfers.sendTransfer.mockRejectedValue(new WhishSessionExpiredError('expired'));
    await runTick(service);
    // Money did NOT move → revert to manual; the whole W2W side is down → trip the
    // breaker (which is what pauses further processing until the session is re-seeded).
    expect(withdrawals.revertFromProcessing).toHaveBeenCalledWith(
      candidate.id,
      candidate.companyId,
      expect.objectContaining({ status: 'SESSION_EXPIRED', errorDetail: 'session_expired' }),
    );
    expect(config.trip).toHaveBeenCalledWith('session_expired');
    // A session-expired transfer must NOT settle or hold-for-reconcile.
    expect(withdrawals.approve).not.toHaveBeenCalled();
  });

  it('(b) a clean FAILED result reverts terminal, records success (system healthy), and audits', async () => {
    const { service, withdrawals, config, transfers } = build({
      state: makeState(),
      candidates: [candidate],
    });
    transfers.sendTransfer.mockResolvedValue({
      status: 'FAILED',
      reference: 'wt_f',
      upstreamMessage: 'insufficient balance',
    });
    await runTick(service);
    expect(withdrawals.revertFromProcessing).toHaveBeenCalledWith(
      candidate.id,
      candidate.companyId,
      expect.objectContaining({ status: 'FAILED', terminal: true, reference: 'wt_f' }),
    );
    // A clean business failure means the SYSTEM is healthy — must not trip the breaker.
    expect(config.recordSuccess).toHaveBeenCalled();
    expect(config.recordFailure).not.toHaveBeenCalled();
    expect(config.trip).not.toHaveBeenCalled();
  });

  it('(b2) a transient Whish "off" failure is categorised TEMPORARY and never trips the breaker', async () => {
    const { service, withdrawals, config, transfers } = build({
      state: makeState(),
      candidates: [candidate],
    });
    // The exact prod reply: HTTP 200, status:false, code "off" (Whish momentarily
    // unavailable). Money did NOT move — a single transient must NOT pause the queue.
    transfers.sendTransfer.mockResolvedValue({
      status: 'FAILED',
      reference: 'wt_off',
      upstreamCode: 'off',
      upstreamMessage: 'Please try again later.',
    });
    await runTick(service);
    expect(withdrawals.revertFromProcessing).toHaveBeenCalledWith(
      candidate.id,
      candidate.companyId,
      expect.objectContaining({ status: 'FAILED', terminal: true, failureCategory: 'TEMPORARY' }),
    );
    expect(config.recordSuccess).toHaveBeenCalled();
    expect(config.recordFailure).not.toHaveBeenCalled();
    expect(config.trip).not.toHaveBeenCalled();
  });

  it('(b3) a receiver-side rejection is categorised RECEIVER', async () => {
    const { service, withdrawals, config, transfers } = build({
      state: makeState(),
      candidates: [candidate],
    });
    transfers.sendTransfer.mockResolvedValue({
      status: 'FAILED',
      reference: 'wt_r',
      upstreamCode: 'account.topup.check.condition.fail',
      upstreamMessage:
        'This transaction could not be completed at this time. Please reach out to the receiver.',
    });
    await runTick(service);
    expect(withdrawals.revertFromProcessing).toHaveBeenCalledWith(
      candidate.id,
      candidate.companyId,
      expect.objectContaining({ status: 'FAILED', terminal: true, failureCategory: 'RECEIVER' }),
    );
    expect(config.trip).not.toHaveBeenCalled();
  });

  it('(c) an UNKNOWN/PENDING result holds the row needsReconcile (never auto-retried), no revert', async () => {
    const { service, withdrawals, config, transfers } = build({
      state: makeState(),
      candidates: [candidate],
    });
    transfers.sendTransfer.mockResolvedValue({
      status: 'UNKNOWN',
      reference: 'wt_u',
      traceId: 't',
    });
    await runTick(service);
    expect(withdrawals.setAutoMeta).toHaveBeenCalledWith(
      candidate.id,
      candidate.companyId,
      expect.objectContaining({ status: 'UNKNOWN', needsReconcile: true }),
    );
    expect(withdrawals.revertFromProcessing).not.toHaveBeenCalled();
    expect(config.recordFailure).toHaveBeenCalled();
  });

  it('(d2) SUCCESS settle notes name Whish W2W (not the simulated wording)', async () => {
    const { service, withdrawals, transfers } = build({
      state: makeState(),
      candidates: [candidate],
    });
    transfers.sendTransfer.mockResolvedValue({
      status: 'SUCCESS',
      reference: 'wt_x',
      traceId: 't',
    });
    await runTick(service);
    expect(withdrawals.approve).toHaveBeenCalledWith(
      candidate.id,
      null,
      expect.objectContaining({ notes: expect.stringContaining('via Whish W2W') }),
      expect.anything(),
    );
  });

  it('(d) transfer SUCCEEDED but settle threw → hold needsAttention (PROCESSING), never revert', async () => {
    const { service, withdrawals, transfers } = build({
      state: makeState(),
      candidates: [candidate],
    });
    transfers.sendTransfer.mockResolvedValue({
      status: 'SUCCESS',
      reference: 'wt_s',
      traceId: 't',
    });
    withdrawals.approve.mockRejectedValue(new Error('receivable appeared'));
    await runTick(service);
    // Money LEFT but settle failed → keep PROCESSING, flag for retry; never revert.
    expect(withdrawals.setAutoMeta).toHaveBeenCalledWith(
      candidate.id,
      candidate.companyId,
      expect.objectContaining({ status: 'SUCCESS', needsAttention: true }),
    );
    expect(withdrawals.revertFromProcessing).not.toHaveBeenCalled();
  });
});

// SIMULATION MODE (WITHDRAWAL_AUTO_APPROVAL_SIMULATE — staging): the pipeline
// must run end-to-end with the Whish side completely absent, and must be
// STRUCTURALLY incapable of sending a transfer. The core assertion in every
// test here: transfers.sendTransfer is never called.
describe('WithdrawalAutoApprovalService — simulate mode never moves money', () => {
  it('approves a candidate with a SIMULATED reference — no transfer, no session read', async () => {
    const { service, withdrawals, transfers, config, audit } = build({
      state: makeState(),
      simulate: true,
      w2wEnabled: false, // staging reality: real W2W is off
      sessionConfigured: false, // ...and no Whish session exists
    });
    withdrawals.findAutoApprovalCandidates.mockResolvedValue([candidate]);
    await runTick(service);
    expect(transfers.sendTransfer).not.toHaveBeenCalled();
    expect(transfers.sessionStatus).not.toHaveBeenCalled();
    // Same settle path as prod: floorWhole + skipReceivableBlock, fake reference.
    expect(withdrawals.approve).toHaveBeenCalledWith(
      candidate.id,
      null,
      expect.objectContaining({
        externalReference: `SIMULATED-${candidate.id}`,
        notes: expect.stringContaining('SIMULATED'),
      }),
      expect.objectContaining({ floorWhole: true, skipReceivableBlock: true }),
    );
    expect(config.recordSuccess).toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'withdrawal.auto_approved',
        metadata: expect.objectContaining({ simulated: true }),
      }),
    );
  });

  it('refuses to run at all when the real W2W flag is somehow also on', async () => {
    const { service, withdrawals, transfers } = build({
      state: makeState(),
      simulate: true,
      w2wEnabled: true, // must never happen (env validation), but never simulate through it
      candidates: [candidate],
    });
    await runTick(service);
    expect(withdrawals.findAutoApprovalCandidates).not.toHaveBeenCalled();
    expect(withdrawals.claimForProcessing).not.toHaveBeenCalled();
    expect(withdrawals.approve).not.toHaveBeenCalled();
    expect(transfers.sendTransfer).not.toHaveBeenCalled();
  });

  it('the admin toggle still gates: OFF ⇒ nothing is claimed or approved', async () => {
    const { service, withdrawals, transfers } = build({
      state: makeState({ enabled: false, enabledAt: null }),
      simulate: true,
      w2wEnabled: false,
      candidates: [candidate],
    });
    await runTick(service);
    expect(withdrawals.findAutoApprovalCandidates).not.toHaveBeenCalled();
    expect(withdrawals.approve).not.toHaveBeenCalled();
    expect(transfers.sendTransfer).not.toHaveBeenCalled();
  });

  it('a tripped breaker does not block simulation (no Whish session to resume against)', async () => {
    const { service, withdrawals, transfers, config } = build({
      state: makeState({ circuitBreakerTrippedAt: new Date('2026-06-01T10:00:00Z') }),
      simulate: true,
      w2wEnabled: false,
      sessionConfigured: false,
    });
    withdrawals.findAutoApprovalCandidates.mockResolvedValue([candidate]);
    await runTick(service);
    expect(config.maybeAutoResume).not.toHaveBeenCalled();
    expect(withdrawals.approve).toHaveBeenCalled();
    expect(transfers.sendTransfer).not.toHaveBeenCalled();
  });

  it('a row without a recipient phone still drops to manual (parity with prod)', async () => {
    const { service, withdrawals, transfers } = build({
      state: makeState(),
      simulate: true,
      w2wEnabled: false,
      candidates: [{ ...candidate, payoutDetails: {} }],
    });
    await runTick(service);
    expect(withdrawals.revertFromProcessing).toHaveBeenCalledWith(
      candidate.id,
      candidate.companyId,
      expect.objectContaining({ status: 'FAILED', terminal: true }),
    );
    expect(withdrawals.approve).not.toHaveBeenCalled();
    expect(transfers.sendTransfer).not.toHaveBeenCalled();
  });
});
