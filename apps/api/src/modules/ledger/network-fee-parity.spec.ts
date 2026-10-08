import { describe, expect, it } from 'vitest';
import { Money, type FeeApplication } from '@app/shared';
import type { LedgerEntryInput } from './ledger.service';
import {
  feesConsumeAmountError,
  moneyInEntries,
  netOfFee,
  reservedTotal,
  reversalEntries,
  settleEntries,
  type FeeParts,
} from './flow-ledger';
import { ValidationError } from '../../common/errors/domain.error';

/**
 * THE network-fee safety net: with the network fee at 0 — every company whose
 * switch is off, i.e. every company until a SUPER_ADMIN turns it on — the new
 * two-fee code must book EXACTLY what the single-fee code booked before.
 *
 * The oracle below is the pre-network-fee code, copied verbatim (only renamed),
 * from flow-ledger.ts, transactions.service.ts (ingest + reverse),
 * withdrawals.service.ts (approve) and loads.service.ts (approve). Do not
 * "fix" or refactor it: it is a frozen record of the old behaviour, and its
 * whole value is that it does not change when the production code does.
 * (Precedent: auto-approval-parity.spec.ts.)
 */

// ---------------- frozen oracle: the single-fee code ----------------

function oldReservedTotal(amount: Money, fee: Money, feeApplication: FeeApplication): Money {
  return feeApplication === 'ON_TOP' ? amount.add(fee) : amount;
}

function oldNetOfFee(amount: Money, fee: Money, feeApplication: FeeApplication): Money {
  return feeApplication === 'ON_TOP' ? amount : amount.sub(fee);
}

type FlowRef = Pick<LedgerEntryInput, 'withdrawalId' | 'payoutId'>;

function oldSettleEntries(
  ref: FlowRef,
  companyId: string,
  currency: string,
  reserved: Money,
  external: Money,
  fee: Money,
): LedgerEntryInput[] {
  const entries: LedgerEntryInput[] = [
    { ...ref, companyId, accountType: 'RESERVED', direction: 'DEBIT', amount: reserved, currency },
  ];
  if (external.isPositive()) {
    entries.push({
      ...ref,
      companyId,
      accountType: 'EXTERNAL',
      direction: 'CREDIT',
      amount: external,
      currency,
    });
  }
  if (fee.isPositive()) {
    entries.push({
      ...ref,
      companyId,
      accountType: 'FEE',
      direction: 'CREDIT',
      amount: fee,
      currency,
    });
  }
  return entries;
}

/** transactions.service.ts ingest(): the inline deposit ledger set. */
function oldDepositLegs(
  companyId: string,
  transactionId: string,
  currency: string,
  externalDebit: Money,
  availableCredit: Money,
  fee: Money,
): LedgerEntryInput[] {
  const ledgerLines: LedgerEntryInput[] = [
    {
      companyId,
      transactionId,
      accountType: 'EXTERNAL',
      direction: 'DEBIT',
      amount: externalDebit,
      currency,
    },
  ];
  if (availableCredit.isPositive()) {
    ledgerLines.push({
      companyId,
      transactionId,
      accountType: 'AVAILABLE',
      direction: 'CREDIT',
      amount: availableCredit,
      currency,
    });
  }
  if (fee.isPositive()) {
    ledgerLines.push({
      companyId,
      transactionId,
      accountType: 'FEE',
      direction: 'CREDIT',
      amount: fee,
      currency,
    });
  }
  return ledgerLines;
}

/** transactions.service.ts reverse(): the inline reversal ledger set. */
function oldReversalLegs(
  companyId: string,
  transactionId: string,
  currency: string,
  net: Money,
  fee: Money,
  fromAvailable: Money,
  receivable: Money,
  reason: string,
): LedgerEntryInput[] {
  const externalAmount = net.add(fee);
  const lines: LedgerEntryInput[] = [
    {
      companyId,
      transactionId,
      accountType: 'EXTERNAL',
      direction: 'CREDIT',
      amount: externalAmount,
      currency,
      metadata: { kind: 'reversal', reason },
    },
  ];
  if (fromAvailable.isPositive()) {
    lines.push({
      companyId,
      transactionId,
      accountType: 'AVAILABLE',
      direction: 'DEBIT',
      amount: fromAvailable,
      currency,
      metadata: { kind: 'reversal' },
    });
  }
  if (receivable.isPositive()) {
    lines.push({
      companyId,
      transactionId,
      accountType: 'RECEIVABLE',
      direction: 'DEBIT',
      amount: receivable,
      currency,
      metadata: { kind: 'reversal', shortfall: true },
    });
  }
  if (fee.isPositive()) {
    lines.push({
      companyId,
      transactionId,
      accountType: 'FEE',
      direction: 'DEBIT',
      amount: fee,
      currency,
      metadata: { kind: 'reversal' },
    });
  }
  return lines;
}

/** loads.service.ts approve(): the inline load ledger set (incl. receivable settlement). */
function oldLoadLegs(
  companyId: string,
  loadId: string,
  currency: string,
  externalDebit: Money,
  settle: Money,
  creditToAvailable: Money,
  fee: Money,
): LedgerEntryInput[] {
  const entries: LedgerEntryInput[] = [
    {
      companyId,
      loadId,
      accountType: 'EXTERNAL',
      direction: 'DEBIT',
      amount: externalDebit,
      currency,
    },
  ];
  if (settle.isPositive()) {
    entries.push({
      companyId,
      loadId,
      accountType: 'RECEIVABLE',
      direction: 'CREDIT',
      amount: settle,
      currency,
      metadata: { kind: 'receivable_settlement' },
    });
  }
  if (creditToAvailable.isPositive()) {
    entries.push({
      companyId,
      loadId,
      accountType: 'AVAILABLE',
      direction: 'CREDIT',
      amount: creditToAvailable,
      currency,
    });
  }
  if (fee.isPositive()) {
    entries.push({
      companyId,
      loadId,
      accountType: 'FEE',
      direction: 'CREDIT',
      amount: fee,
      currency,
    });
  }
  return entries;
}

// ---------------- the sweep ----------------

const CO = 'co-1';
const USD = 'USD';
const AMOUNTS = [
  '0.01',
  '0.03',
  '0.99',
  '1.00',
  '1.01',
  '9.99',
  '10.00',
  '18.67',
  '33.33',
  '99.99',
  '100.00',
  '123.45',
  '12345.67',
];
const RATES = ['0', '0.125', '1', '2.5', '3.333333', '6.65', '50', '100'];
const APPS: FeeApplication[] = ['DEDUCTED', 'ON_TOP'];
const ZERO = Money.zero();
const off = (commission: Money): FeeParts => ({ commission, network: ZERO });

/**
 * Compare ledger sets on everything that is persisted: account, direction, the
 * exact amount (every digit, not a rounded display), the row refs, the metadata
 * and the ORDER of the legs.
 */
function normalize(entries: LedgerEntryInput[]) {
  return entries.map((e) => ({ ...e, amount: e.amount.toExactString() }));
}

const cases: { amount: Money; fee: Money; app: FeeApplication }[] = [];
for (const a of AMOUNTS) {
  for (const r of RATES) {
    for (const app of APPS) {
      const amount = Money.of(a);
      cases.push({ amount, fee: amount.percent(r).round(), app });
    }
  }
}

describe('network fee OFF (0) books exactly what the single-fee code booked', () => {
  it('sweeps a meaningful grid', () => {
    expect(cases.length).toBe(AMOUNTS.length * RATES.length * APPS.length);
  });

  it('reservedTotal / netOfFee are value-identical', () => {
    for (const { amount, fee, app } of cases) {
      expect(reservedTotal(amount, off(fee), app).toExactString()).toBe(
        oldReservedTotal(amount, fee, app).toExactString(),
      );
      expect(netOfFee(amount, off(fee), app).toExactString()).toBe(
        oldNetOfFee(amount, fee, app).toExactString(),
      );
    }
  });

  it('deposit ingest legs are identical', () => {
    for (const { amount, fee, app } of cases) {
      // Deposits book whenever the fee fits (a capped fee is the amount itself).
      if (app === 'DEDUCTED' && fee.gt(amount)) continue;
      const externalDebit = oldReservedTotal(amount, fee, app);
      const availableCredit = oldNetOfFee(amount, fee, app);
      const next = moneyInEntries({ transactionId: 't-1' }, CO, USD, {
        externalDebit: reservedTotal(amount, off(fee), app),
        receivableSettle: ZERO,
        availableCredit: netOfFee(amount, off(fee), app),
        fees: off(fee),
      });
      const prev = oldDepositLegs(CO, 't-1', USD, externalDebit, availableCredit, fee);
      expect(normalize(next)).toEqual(normalize(prev));
    }
  });

  it('withdrawal / payout approval legs are identical, including the whole-dollar floor', () => {
    for (const { amount, fee, app } of cases) {
      const net = oldNetOfFee(amount, fee, app);
      if (!net.isPositive()) continue; // refused at request
      for (const floorWhole of [false, true]) {
        // Old approve(): external, then feeRealized = reserved − external.
        const reserved = oldReservedTotal(amount, fee, app);
        const external = floorWhole ? net.floorToWhole() : net;
        const prev = oldSettleEntries(
          { withdrawalId: 'w-1' },
          CO,
          USD,
          reserved,
          external,
          reserved.sub(external),
        );
        // New approve(): realized = { reserved − external − network, network }.
        const fees = off(fee);
        const newReserved = reservedTotal(amount, fees, app);
        const newNet = netOfFee(amount, fees, app);
        const newExternal = floorWhole ? newNet.floorToWhole() : newNet;
        const next = settleEntries({ withdrawalId: 'w-1' }, CO, USD, newReserved, newExternal, {
          commission: newReserved.sub(newExternal).sub(fees.network),
          network: fees.network,
        });
        expect(normalize(next)).toEqual(normalize(prev));
        // rounding_remainder is unchanged too.
        expect(newNet.sub(newExternal).toExactString()).toBe(net.sub(external).toExactString());
      }
    }
  });

  it('load approval legs are identical across every receivable situation', () => {
    for (const { amount, fee, app } of cases) {
      const credit = oldNetOfFee(amount, fee, app);
      if (!credit.isPositive()) continue; // refused at request
      for (const owed of [ZERO, credit.div(3).floorToScale(), credit, credit.add(Money.of('5'))]) {
        const settle = owed.isPositive() ? (owed.gt(credit) ? credit : owed) : ZERO;
        const prev = oldLoadLegs(
          CO,
          'l-1',
          USD,
          oldReservedTotal(amount, fee, app),
          settle,
          credit.sub(settle),
          fee,
        );
        const next = moneyInEntries({ loadId: 'l-1' }, CO, USD, {
          externalDebit: reservedTotal(amount, off(fee), app),
          receivableSettle: settle,
          availableCredit: netOfFee(amount, off(fee), app).sub(settle),
          fees: off(fee),
        });
        expect(normalize(next)).toEqual(normalize(prev));
      }
    }
  });

  it('deposit reversal legs are identical across every clawback split', () => {
    for (const { amount, fee, app } of cases) {
      if (app === 'DEDUCTED' && fee.gt(amount)) continue;
      const net = oldNetOfFee(amount, fee, app);
      for (const [fromAvailable, receivable] of [
        [net, ZERO],
        [ZERO, net],
        [net.div(2).floorToScale(), net.sub(net.div(2).floorToScale())],
      ] as const) {
        const prev = oldReversalLegs(
          CO,
          't-1',
          USD,
          net,
          fee,
          fromAvailable,
          receivable,
          'chargeback',
        );
        const next = reversalEntries({ transactionId: 't-1' }, CO, USD, {
          net,
          fees: off(fee),
          fromAvailable,
          receivable,
          reason: 'chargeback',
        });
        expect(normalize(next)).toEqual(normalize(prev));
      }
    }
  });

  it('the fee-consumes-the-amount rejection keeps its exact message and details', () => {
    for (const consequence of ['the recipient would receive 0', 'nothing would be credited']) {
      const err = feesConsumeAmountError(Money.of('5'), off(Money.of('5')), 'USD', consequence);
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.message).toBe(
        `The 5 USD fee consumes the entire amount — ${consequence}. Increase the amount or fix the fee rule.`,
      );
      expect(err.details).toEqual({ amount: '5', fee: '5' });
    }
  });

  // A parity check that can never fail proves nothing: a real network fee MUST
  // change the booking.
  it('negative control: a 0.01 network fee does change the booked legs', () => {
    const amount = Money.of('100');
    const fee = Money.of('2');
    const fees: FeeParts = { commission: fee, network: Money.of('0.01') };
    const next = moneyInEntries({ transactionId: 't-1' }, CO, USD, {
      externalDebit: reservedTotal(amount, fees, 'DEDUCTED'),
      receivableSettle: ZERO,
      availableCredit: netOfFee(amount, fees, 'DEDUCTED'),
      fees,
    });
    const prev = oldDepositLegs(CO, 't-1', USD, amount, oldNetOfFee(amount, fee, 'DEDUCTED'), fee);
    expect(normalize(next)).not.toEqual(normalize(prev));
    expect(next.map((e) => e.accountType)).toEqual(['EXTERNAL', 'AVAILABLE', 'FEE', 'NETWORK_FEE']);
  });
});
