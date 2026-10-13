import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@app/db';
import { WhishTransferStatus } from '@app/shared';
import {
  TransferInProgressError,
  WhishTransfersService,
  type TransferOrigin,
} from './whish-transfers.service';
import { LeaseUnavailableError } from '../../database/job-lease.service';
import { WhishSessionExpiredError } from './whish-w2w.client';
import { W2WCryptoError } from './w2w-crypto';
import { ValidationError } from '../../common/errors/domain.error';

// ---- Mock collaborators --------------------------------------------------
// runAsAdmin(fn) just runs fn(tx); we hand it a fake `whishTransfer` delegate
// backed by an in-memory store so create/findUnique/update behave like Prisma.

function makeFakeDb() {
  const rows = new Map<string, Record<string, unknown>>();
  let seq = 0;
  const delegate = {
    findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      for (const r of rows.values()) {
        if (where.id && r.id === where.id) return { ...r };
        if (where.reference && r.reference === where.reference) return { ...r };
        if (where.withdrawalId && r.withdrawalId === where.withdrawalId) return { ...r };
      }
      return null;
    }),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      // emulate the unique constraints on reference + withdrawalId
      for (const r of rows.values()) {
        if (
          r.reference === data.reference ||
          (data.withdrawalId && r.withdrawalId === data.withdrawalId)
        ) {
          throw new Prisma.PrismaClientKnownRequestError('dup', {
            code: 'P2002',
            clientVersion: 'x',
          });
        }
      }
      const id = `wt-${++seq}`;
      const row = {
        id,
        traceId: null,
        upstreamCode: null,
        upstreamMessage: null,
        errorDetail: null,
        responseBody: null,
        requestBody: null,
        sessionCounter: null,
        createdAt: new Date(),
        amount: new Prisma.Decimal(String(data.amount ?? '0')),
        currency: 'USD',
        ...data,
      };
      rows.set(id, row);
      return { ...row };
    }),
    update: vi.fn(
      async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = rows.get(where.id);
        if (!row) throw new Error('row not found');
        Object.assign(row, data);
        return { ...row };
      },
    ),
  };
  return { rows, delegate };
}

function build(opts: {
  submit?: ReturnType<typeof vi.fn>;
  submitThrows?: Error;
  nextRequest?: ReturnType<typeof vi.fn>;
  isEnabled?: boolean;
  seedRow?: Record<string, unknown>;
  /** The cross-instance send lease stays with another instance past the wait. */
  leaseBusy?: boolean;
}) {
  const { rows, delegate } = makeFakeDb();
  if (opts.seedRow) rows.set(opts.seedRow.id as string, opts.seedRow);

  const prisma = {
    runAsAdmin: vi.fn(<T>(fn: (tx: unknown) => Promise<T>) => fn({ whishTransfer: delegate })),
  };
  const client = {
    isEnabled: vi.fn().mockReturnValue(opts.isEnabled ?? true),
    submit:
      opts.submit ??
      vi.fn(async () => {
        if (opts.submitThrows) throw opts.submitThrows;
        return {
          outcome: 'success',
          httpStatus: 200,
          traceId: 't1',
          nextCounter: 2,
          code: null,
          message: null,
          response: { status: true },
        };
      }),
    buildRedactedRequest: vi.fn().mockReturnValue({ redacted: true }),
  };
  const session = {
    nextRequest:
      opts.nextRequest ??
      vi.fn().mockResolvedValue({
        token: 't',
        uid: 'u',
        sessionId: 's',
        deviceId: 'd',
        serverId: 'sv',
        itelVersion: 'i',
        osVersion: 'o',
        operatingSystem: 'os',
        userAgent: 'ua',
        sessionCounter: 1,
      }),
    healCounter: vi.fn().mockResolvedValue(undefined),
    markAuthFailure: vi.fn().mockResolvedValue(undefined),
    status: vi.fn(),
  };
  const txLogs = { record: vi.fn() };
  const realtime = { admin: vi.fn(), company: vi.fn() };
  // The real lease runs against Postgres (test/integration/job-leases.int-spec.ts);
  // here it either grants the turn (running the send inside it) or never does.
  const leases = {
    withLease: vi.fn(async (name: string, _opts: unknown, fn: () => Promise<unknown>) => {
      if (opts.leaseBusy) throw new LeaseUnavailableError(name);
      return fn();
    }),
  };

  const svc = new WhishTransfersService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    session as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    txLogs as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    realtime as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    leases as any,
  );
  return { svc, rows, delegate, client, session, txLogs, realtime, leases };
}

const ORIGIN: TransferOrigin = {
  source: 'WITHDRAWAL',
  actorId: null,
  companyId: 'c1',
  withdrawalId: 'w1',
};

describe('WhishTransfersService.sendTransfer (audit) — session-expired classification', () => {
  it('classifies a session-expired submit as FAILED/session_expired and RE-THROWS WhishSessionExpiredError', async () => {
    const { svc, rows, session } = build({
      submitThrows: new WhishSessionExpiredError('expired'),
    });
    await expect(
      svc.sendTransfer({ amount: '20', recipientPhone: '71505894', currency: 'USD' }, ORIGIN),
    ).rejects.toBeInstanceOf(WhishSessionExpiredError);

    // The row must be persisted FAILED with errorDetail=session_expired (the marker
    // the idempotent replay path keys off) and the session flagged.
    const row = [...rows.values()][0];
    expect(row.status).toBe(WhishTransferStatus.FAILED);
    expect(row.errorDetail).toBe('session_expired');
    expect(session.markAuthFailure).toHaveBeenCalledOnce();
  });

  it('a prior FAILED/session_expired row is RESET to PENDING and re-sent (manual recovery after re-seed)', async () => {
    const { svc, rows, client, session } = build({
      seedRow: {
        id: 'wt-existing',
        reference: 'ref-1',
        withdrawalId: 'w1',
        status: WhishTransferStatus.FAILED,
        errorDetail: 'session_expired',
        amount: new Prisma.Decimal('20'),
        currency: 'USD',
        createdAt: new Date(),
        traceId: null,
        upstreamMessage: null,
        source: 'WITHDRAWAL',
        recipientPhone: '71505894',
      },
    });
    const res = await svc.sendTransfer(
      { amount: '20', recipientPhone: '71505894', currency: 'USD' },
      ORIGIN,
    );
    // It re-sent (submit reached) and landed SUCCESS on the SAME row id.
    expect(client.submit).toHaveBeenCalledOnce();
    expect(session.nextRequest).toHaveBeenCalled();
    expect(res.status).toBe(WhishTransferStatus.SUCCESS);
    const row = rows.get('wt-existing')!;
    expect(row.status).toBe(WhishTransferStatus.SUCCESS);
  });

  it('a prior FAILED row with a NON-session_expired detail is NOT replayed (returned as-is)', async () => {
    const { svc, client } = build({
      seedRow: {
        id: 'wt-existing',
        reference: 'ref-1',
        withdrawalId: 'w1',
        status: WhishTransferStatus.FAILED,
        errorDetail: 'transfer_failed',
        amount: new Prisma.Decimal('20'),
        currency: 'USD',
        createdAt: new Date(),
        traceId: null,
        upstreamMessage: null,
        source: 'WITHDRAWAL',
        recipientPhone: '71505894',
      },
    });
    const res = await svc.sendTransfer(
      { amount: '20', recipientPhone: '71505894', currency: 'USD' },
      ORIGIN,
    );
    expect(client.submit).not.toHaveBeenCalled();
    expect(res.status).toBe(WhishTransferStatus.FAILED);
  });
});

describe('WhishTransfersService.sendTransfer (audit) — decryption failure path', () => {
  it('a decryption failure (W2WCryptoError from nextRequest) is caught → row terminal FAILED + ValidationError (money did NOT move, no breaker-burning UNKNOWN)', async () => {
    const { svc, rows, client } = build({
      nextRequest: vi
        .fn()
        .mockRejectedValue(
          new W2WCryptoError('could not decrypt W2W session secret (wrong WHISH_W2W_ENC_KEY?)'),
        ),
    });
    // submit() is never reached (decryption is before it), so money did NOT move.
    // The orchestrator must see a ValidationError (its money-did-not-move branch →
    // revert to manual), NOT a raw error it would mis-handle as ambiguous/UNKNOWN.
    await expect(
      svc.sendTransfer({ amount: '20', recipientPhone: '71505894', currency: 'USD' }, ORIGIN),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(client.submit).not.toHaveBeenCalled();

    // The pre-created row is marked terminal FAILED with a distinct detail.
    const row = [...rows.values()][0];
    expect(row.status).toBe(WhishTransferStatus.FAILED);
    expect(row.errorDetail).toBe('session_decrypt_failed');
  });

  it('a SECOND attempt after a decryption failure returns the terminal FAILED row (session_decrypt_failed is NOT resendable; no re-send)', async () => {
    const { svc, rows, client, session } = build({
      nextRequest: vi.fn().mockRejectedValue(new W2WCryptoError('bad key')),
    });
    await expect(
      svc.sendTransfer({ amount: '20', recipientPhone: '71505894', currency: 'USD' }, ORIGIN),
    ).rejects.toBeInstanceOf(ValidationError);
    const failedRow = [...rows.values()][0];
    expect(failedRow.status).toBe(WhishTransferStatus.FAILED);
    expect(failedRow.errorDetail).toBe('session_decrypt_failed');

    // Key fixed; re-drive the SAME withdrawal. Only 'session_expired' rows are
    // resendable, so the idempotency pre-check returns the terminal FAILED row
    // WITHOUT calling submit — the withdrawal is recovered via the manual path.
    session.nextRequest.mockResolvedValue({
      token: 't',
      uid: 'u',
      sessionId: 's',
      deviceId: 'd',
      serverId: 'sv',
      itelVersion: 'i',
      osVersion: 'o',
      operatingSystem: 'os',
      userAgent: 'ua',
      sessionCounter: 1,
    });
    const res = await svc.sendTransfer(
      { amount: '20', recipientPhone: '71505894', currency: 'USD' },
      ORIGIN,
    );
    expect(client.submit).not.toHaveBeenCalled();
    expect(res.status).toBe(WhishTransferStatus.FAILED);
  });
});

describe('WhishTransfersService.sendTransfer (audit) — session-expired resend re-syncs destination fields', () => {
  it('a resent session_expired row persists the NEW amount/phone it actually submits (no stale audit record)', async () => {
    const { svc, rows, client } = build({
      seedRow: {
        id: 'wt-existing',
        reference: 'ref-1',
        withdrawalId: 'w1',
        status: WhishTransferStatus.FAILED,
        errorDetail: 'session_expired',
        amount: new Prisma.Decimal('20'),
        currency: 'USD',
        createdAt: new Date(),
        traceId: null,
        upstreamMessage: null,
        source: 'WITHDRAWAL',
        recipientPhone: '71178866', // stale destination on the old row
      },
    });
    // Operator resends the SAME withdrawal with a corrected amount + phone.
    const res = await svc.sendTransfer(
      { amount: '50', recipientPhone: '70999111', currency: 'USD' },
      ORIGIN,
    );
    expect(client.submit).toHaveBeenCalledOnce();
    expect(res.status).toBe(WhishTransferStatus.SUCCESS);

    // The persisted row must reflect what we actually submitted, not the stale values.
    const row = rows.get('wt-existing')!;
    expect(row.recipientPhone).toBe('70999111');
    expect(new Prisma.Decimal(row.amount as Prisma.Decimal).toString()).toBe('50');
    // And submit was called with the NEW phone (bare msisdn) + 2dp amount.
    expect(client.submit).toHaveBeenCalledWith(
      expect.objectContaining({ phone: '70999111', amount: '50.00' }),
    );
  });
});

describe('WhishTransfersService.sendTransfer (audit) — idempotency + ambiguous outcomes', () => {
  it('an existing SUCCESS row short-circuits without re-sending', async () => {
    const { svc, client } = build({
      seedRow: {
        id: 'wt-existing',
        reference: 'ref-1',
        withdrawalId: 'w1',
        status: WhishTransferStatus.SUCCESS,
        errorDetail: null,
        amount: new Prisma.Decimal('20'),
        currency: 'USD',
        createdAt: new Date(),
        traceId: 't',
        upstreamMessage: null,
        source: 'WITHDRAWAL',
        recipientPhone: '71505894',
      },
    });
    const res = await svc.sendTransfer(
      { amount: '20', recipientPhone: '71505894', currency: 'USD' },
      ORIGIN,
    );
    expect(client.submit).not.toHaveBeenCalled();
    expect(res.status).toBe(WhishTransferStatus.SUCCESS);
  });

  it('an unreachable outcome is recorded UNKNOWN (never FAILED) so it is not auto-retried', async () => {
    const { svc, rows } = build({
      submit: vi.fn().mockResolvedValue({ outcome: 'unreachable', detail: 'timeout' }),
    });
    const res = await svc.sendTransfer(
      { amount: '20', recipientPhone: '71505894', currency: 'USD' },
      ORIGIN,
    );
    expect(res.status).toBe(WhishTransferStatus.UNKNOWN);
    const row = [...rows.values()][0];
    expect(row.status).toBe(WhishTransferStatus.UNKNOWN);
  });

  it('session-not-configured fails the row and throws ValidationError BEFORE any submit', async () => {
    const { svc, rows, client } = build({
      nextRequest: vi.fn().mockResolvedValue(null),
    });
    await expect(
      svc.sendTransfer({ amount: '20', recipientPhone: '71505894', currency: 'USD' }, ORIGIN),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(client.submit).not.toHaveBeenCalled();
    const row = [...rows.values()][0];
    expect(row.status).toBe(WhishTransferStatus.FAILED);
    expect(row.errorDetail).toBe('session_not_configured');
  });
});

describe('WhishTransfersService.map — response exposes the withdrawal linkage', () => {
  // The Transfer-Money history drawer keys off these fields: `source` tells it
  // "auto-transfer vs manual", `withdrawalId`/`companyId` deep-link to the
  // withdrawal it settled, and `errorDetail`/`upstreamMessage` explain a failure.
  // They must survive the mapper, not just live on the row.
  it('a returned transfer DTO carries source, withdrawalId, companyId and the failure reason', async () => {
    const { svc, client } = build({
      seedRow: {
        id: 'wt-existing',
        reference: 'ref-1',
        withdrawalId: 'w1',
        companyId: 'c1',
        status: WhishTransferStatus.FAILED,
        errorDetail: 'transfer_failed', // not session_expired → returned as-is via map()
        amount: new Prisma.Decimal('20'),
        currency: 'USD',
        createdAt: new Date(),
        traceId: null,
        upstreamMessage: 'Whish: recipient not found',
        source: 'WITHDRAWAL',
        recipientPhone: '71505894',
      },
    });
    const res = await svc.sendTransfer(
      { amount: '20', recipientPhone: '71505894', currency: 'USD' },
      ORIGIN,
    );
    expect(client.submit).not.toHaveBeenCalled(); // non-resendable short-circuit
    expect(res.source).toBe('WITHDRAWAL');
    expect(res.withdrawalId).toBe('w1');
    expect(res.companyId).toBe('c1');
    expect(res.errorDetail).toBe('transfer_failed');
    expect(res.upstreamMessage).toBe('Whish: recipient not found');
  });
});

describe('WhishTransfersService.sendTransfer (audit) — recipient phone normalization', () => {
  // The payout schemas accept parens (`wishRecipientPhoneSchema`), and auto-approval
  // forwards `payoutDetails.recipientPhone` verbatim, so anything the schema allows
  // must survive normalization as a bare msisdn — Whish rejects the rest.
  it.each([
    ['+961 (3) 000000', '9613000000'],
    ['+961-70-000-000', '96170000000'],
    ['(03) 000 000', '03000000'],
    ['00961 3 000 000', '009613000000'],
  ])('normalizes %s to %s before submitting', async (input, expected) => {
    const { svc, rows, client } = build({});
    const res = await svc.sendTransfer(
      { amount: '20', recipientPhone: input, currency: 'USD' },
      ORIGIN,
    );

    expect(client.submit).toHaveBeenCalledWith(expect.objectContaining({ phone: expected }));
    // The audit row records the same destination we actually submitted.
    expect(rows.get(res.id)!.recipientPhone).toBe(expected);
  });
});

describe('WhishTransfersService.sendTransfer — one send at a time across instances', () => {
  it('sends only while holding the cross-instance send lease', async () => {
    const { svc, client, leases } = build({});
    let insideLease = false;
    leases.withLease.mockImplementationOnce(
      async (_name: string, _opts: unknown, fn: () => Promise<unknown>) => {
        insideLease = true;
        try {
          return await fn();
        } finally {
          insideLease = false;
        }
      },
    );
    client.submit.mockImplementationOnce(async () => {
      expect(insideLease).toBe(true); // Whish is only ever called inside the lease
      return {
        outcome: 'success',
        httpStatus: 200,
        traceId: 't1',
        nextCounter: 2,
        code: null,
        message: null,
        response: { status: true },
      };
    });
    const res = await svc.sendTransfer(
      { amount: '20', recipientPhone: '71505894', currency: 'USD' },
      ORIGIN,
    );
    expect(res.status).toBe(WhishTransferStatus.SUCCESS);
    expect(leases.withLease).toHaveBeenCalledWith(
      'whish-w2w-send',
      { ttlMs: 60_000, waitMs: 30_000 },
      expect.any(Function),
    );
  });

  it('when another instance keeps the session busy, NOTHING is recorded or sent', async () => {
    const { svc, rows, client, session } = build({ leaseBusy: true });
    await expect(
      svc.sendTransfer({ amount: '20', recipientPhone: '71505894', currency: 'USD' }, ORIGIN),
    ).rejects.toBeInstanceOf(TransferInProgressError);
    expect(rows.size).toBe(0); // no PENDING row: a retry is a clean first attempt
    expect(session.nextRequest).not.toHaveBeenCalled(); // no session counter consumed
    expect(client.submit).not.toHaveBeenCalled(); // money cannot have moved
  });

  it('a busy session is a 409 the admin tool can show, not a 500', () => {
    const err = new TransferInProgressError();
    expect(err.httpStatus).toBe(409);
    expect(err.code).toBe('TRANSFER_IN_PROGRESS');
    expect(err.message).toMatch(/Nothing was sent/);
  });
});
