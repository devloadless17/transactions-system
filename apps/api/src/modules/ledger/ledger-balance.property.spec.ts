import { describe, expect, it } from 'vitest';
import { MONEY_SCALE, Money, type FeeApplication } from '@app/shared';
import { netOfFee, releaseEntries, reservedTotal, reserveEntries } from './flow-ledger';
import { ingestSplit, splitClawback } from '../transactions/transactions.service';

/**
 * THE money-scale invariant, swept rather than sampled.
 *
 * Every ledger set must satisfy three things at the platform money scale:
 *   1. Σ DEBIT == Σ CREDIT      (double entry)
 *   2. every leg is at scale     (nothing needs rounding to persist)
 *   3. every leg is > 0          (the DB CHECK, and a zero leg means a lost split)
 *
 * These hold by CONSTRUCTION when a builder quantizes its inputs once and derives
 * the rest by subtraction — and break the moment anything rounds a leg
 * independently, because `Σ round(legᵢ)` can differ from `round(Σ legᵢ)`.
 *
 * The sweep is deterministic (no fuzzing dependency, no flaky seeds): a grid of
 * amounts chosen to land on and around exact half-cents, crossed with rates that
 * include sub-basis-point values, crossed with both fee applications. That is
 * ~4k builder invocations per flow and covers the cases hand-written examples
 * habitually miss — a rate whose product lands exactly on a half cent.
 */

const REF = { withdrawalId: 'w-1' } as const;
const CO = 'co-1';
const USD = 'USD';

// Amounts around the awkward boundaries: sub-cent, exact half-cents, carries.
const AMOUNTS = [
  '0.01',
  '0.02',
  '0.03',
  '0.05',
  '0.07',
  '0.09',
  '0.10',
  '0.99',
  '1.00',
  '1.01',
  '1.99',
  '2.00',
  '9.99',
  '10.00',
  '10.01',
  '10.03',
  '33.33',
  '49.99',
  '50.00',
  '50.40',
  '99.99',
  '100.00',
  '123.45',
  '999.99',
  '1000.00',
  '12345.67',
];

// Rates including sub-basis-point ones, which is exactly what the dual-typed
// value split exists to keep expressible.
const RATES = ['0', '0.125', '0.5', '1', '1.5', '2', '2.5', '3.333333', '10', '33.33', '50', '100'];

const APPLICATIONS: FeeApplication[] = ['ON_TOP', 'DEDUCTED'];

interface Leg {
  direction: 'DEBIT' | 'CREDIT';
  amount: Money;
}

function assertSetIsSound(legs: Leg[], label: string): void {
  let dr = Money.zero();
  let cr = Money.zero();
  for (const l of legs) {
    expect(
      l.amount.isAtScale(),
      `${label}: leg ${l.amount.toExactString()} exceeds ${MONEY_SCALE}dp`,
    ).toBe(true);
    expect(l.amount.isPositive(), `${label}: leg ${l.amount.toString()} is not > 0`).toBe(true);
    if (l.direction === 'DEBIT') dr = dr.add(l.amount);
    else cr = cr.add(l.amount);
  }
  expect(dr.eq(cr), `${label}: debits ${dr.toString()} != credits ${cr.toString()}`).toBe(true);
}

/** Builders skip zero legs the way the real services do (a 0 fee books no FEE leg). */
const nonZero = (legs: { direction: 'DEBIT' | 'CREDIT'; amount: Money }[]): Leg[] =>
  legs.filter((l) => !l.amount.isZero());

describe('every ledger set balances at the platform money scale', () => {
  // The fee is quantized ONCE, exactly as the resolver does, and every remaining
  // leg is derived from it — that is the contract the ledger asserts.
  const cases: { amount: Money; fee: Money; app: FeeApplication }[] = [];
  for (const a of AMOUNTS) {
    for (const r of RATES) {
      for (const app of APPLICATIONS) {
        const amount = Money.of(a);
        const fee = amount.percent(r).round();
        // DEDUCTED with a fee >= amount is refused upstream (CommissionExceedsAmount).
        if (app === 'DEDUCTED' && fee.gte(amount)) continue;
        cases.push({ amount, fee, app });
      }
    }
  }

  it(`sweeps ${AMOUNTS.length} amounts x ${RATES.length} rates x 2 applications`, () => {
    expect(cases.length).toBeGreaterThan(500);
  });

  // A sweep that cannot fail proves nothing — pin that the assertion itself
  // rejects each way a set can be wrong.
  it('the assertion catches an unbalanced, over-scale, or zero leg', () => {
    expect(() =>
      assertSetIsSound(
        [
          { direction: 'DEBIT', amount: Money.of('0.03') },
          { direction: 'CREDIT', amount: Money.of('0.02') },
        ],
        'unbalanced',
      ),
    ).toThrow();
    expect(() =>
      assertSetIsSound(
        [
          { direction: 'DEBIT', amount: Money.of('0.005') },
          { direction: 'CREDIT', amount: Money.of('0.005') },
        ],
        'over-scale',
      ),
    ).toThrow();
    expect(() =>
      assertSetIsSound(
        [
          { direction: 'DEBIT', amount: Money.zero() },
          { direction: 'CREDIT', amount: Money.zero() },
        ],
        'zero leg',
      ),
    ).toThrow();
  });

  // The exact shape the old code produced: round each leg independently instead
  // of deriving by subtraction. 50% of 0.03 → fee 0.02, net 0.01 derived is fine,
  // but independently rounding a partition is not — this is the regression the
  // whole design exists to prevent.
  it('independently rounding a partition DOES break the invariant', () => {
    const half = Money.of('0.005');
    // Two legs that each round to zero while their sum rounds to one cent.
    expect(half.round().add(half.round()).eq(half.add(half).round())).toBe(false);
  });

  it('ingest (deposit) books a balanced, at-scale set', () => {
    for (const { amount, fee, app } of cases) {
      const s = ingestSplit(amount, fee, app);
      assertSetIsSound(
        nonZero([
          { direction: 'DEBIT', amount: s.externalDebit },
          { direction: 'CREDIT', amount: s.availableCredit },
          { direction: 'CREDIT', amount: fee },
        ]),
        `ingest ${amount.toString()}/${fee.toString()}/${app}`,
      );
    }
  });

  it('reserve + release (request, then reject/cancel) balance and mirror each other', () => {
    for (const { amount, fee, app } of cases) {
      const reserved = reservedTotal(amount, fee, app);
      const label = `reserve ${amount.toString()}/${fee.toString()}/${app}`;
      assertSetIsSound(reserveEntries(REF, CO, USD, reserved) as unknown as Leg[], label);
      // The release must move exactly what the reserve moved, or the wallet drifts.
      assertSetIsSound(releaseEntries(REF, CO, USD, reserved) as unknown as Leg[], `re${label}`);
    }
  });

  it('settle (approval) balances, including the whole-dollar floor path', () => {
    for (const { amount, fee, app } of cases) {
      const reserved = reservedTotal(amount, fee, app);
      const net = netOfFee(amount, fee, app);
      for (const floorWhole of [false, true]) {
        const external = floorWhole ? net.floorToWhole() : net;
        // A zero payout is refused upstream (AUTO_APPROVE_MIN_NET) — skip it here
        // rather than assert a leg the real flow would never build.
        if (!external.isPositive()) continue;
        const feeRealized = reserved.sub(external);
        assertSetIsSound(
          nonZero([
            { direction: 'DEBIT', amount: reserved },
            { direction: 'CREDIT', amount: external },
            { direction: 'CREDIT', amount: feeRealized },
          ]),
          `settle ${amount.toString()}/${fee.toString()}/${app}/floor=${floorWhole}`,
        );
        // The remainder kept by the platform is itself representable.
        expect(net.sub(external).isAtScale()).toBe(true);
      }
    }
  });

  it('reversal clawback splits across AVAILABLE and RECEIVABLE without drift', () => {
    for (const { amount, fee, app } of cases) {
      const net = netOfFee(amount, fee, app);
      if (!net.isPositive()) continue;
      // Sweep the wallet from empty to fully-funded, including a legacy balance
      // carrying a sub-cent tail — the case that used to overdraw the wallet.
      for (const available of [Money.zero(), net.div(2), net, net.add(Money.of('0.00000001'))]) {
        const { fromAvailable, receivable } = splitClawback(net, available);
        expect(fromAvailable.isAtScale()).toBe(true);
        expect(receivable.isAtScale()).toBe(true);
        // The two parts must reconstruct the net exactly — no money invented or lost.
        expect(fromAvailable.add(receivable).eq(net)).toBe(true);
        // And we can never claw back more than the wallet actually holds.
        expect(fromAvailable.gt(available.floorToScale())).toBe(false);
      }
    }
  });
});
