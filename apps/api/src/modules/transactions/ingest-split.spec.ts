import { describe, expect, it } from 'vitest';
import { Money } from '@app/shared';
import type { FeeParts } from '../ledger/flow-ledger';
import { ingestSplit, splitClawback } from './transactions.service';

/** Both fees on a row; the network fee defaults to 0 (the switch-off case). */
const fees = (commission: string, network = '0'): FeeParts => ({
  commission: Money.of(commission),
  network: Money.of(network),
});

describe('ingestSplit', () => {
  it('DEDUCTED: fee comes out of the amount', () => {
    const { externalDebit, availableCredit } = ingestSplit(Money.of('100'), fees('3'), 'DEDUCTED');
    expect(externalDebit.toString()).toBe('100');
    expect(availableCredit.toString()).toBe('97');
  });

  it('ON_TOP: fee is added on top; company gets the full amount', () => {
    const { externalDebit, availableCredit } = ingestSplit(Money.of('100'), fees('3'), 'ON_TOP');
    expect(externalDebit.toString()).toBe('103');
    expect(availableCredit.toString()).toBe('100');
  });

  it('keeps the ledger balanced (external == credit + fee) for both applications', () => {
    for (const app of ['DEDUCTED', 'ON_TOP'] as const) {
      const amount = Money.of('250.50');
      const fee = Money.of('2.75');
      const { externalDebit, availableCredit } = ingestSplit(amount, fees('2.75'), app);
      expect(externalDebit.toString()).toBe(availableCredit.add(fee).toString());
    }
  });

  it('reverse() reconstructs the original external as net + fee for both applications', () => {
    // Mirrors transactions.reverse(): externalAmount = stored net + fee.
    const amount = Money.of('100');
    const fee = Money.of('3');
    for (const app of ['DEDUCTED', 'ON_TOP'] as const) {
      const { externalDebit, availableCredit } = ingestSplit(amount, fees('3'), app);
      const reconstructed = availableCredit.add(fee); // net + fee
      expect(reconstructed.toString()).toBe(externalDebit.toString());
    }
  });

  it('DEDUCTED with a full-amount fee credits zero (net 0)', () => {
    const { externalDebit, availableCredit } = ingestSplit(
      Money.of('100'),
      fees('100'),
      'DEDUCTED',
    );
    expect(externalDebit.toString()).toBe('100');
    expect(availableCredit.toString()).toBe('0');
  });

  // The tech lead's example: a $100 deposit with a $2 fee and a 1% network fee.
  it('DEDUCTED with a network fee: both fees come out of the amount', () => {
    const { externalDebit, availableCredit } = ingestSplit(
      Money.of('100'),
      fees('2', '1'),
      'DEDUCTED',
    );
    expect(externalDebit.toString()).toBe('100');
    expect(availableCredit.toString()).toBe('97');
  });

  it('ON_TOP with a network fee: both fees are added on top', () => {
    const { externalDebit, availableCredit } = ingestSplit(
      Money.of('100'),
      fees('2', '1'),
      'ON_TOP',
    );
    expect(externalDebit.toString()).toBe('103');
    expect(availableCredit.toString()).toBe('100');
  });

  it('external == credit + commission + network for both applications', () => {
    for (const app of ['DEDUCTED', 'ON_TOP'] as const) {
      const { externalDebit, availableCredit } = ingestSplit(
        Money.of('250.50'),
        fees('2.75', '1.25'),
        app,
      );
      expect(externalDebit.toString()).toBe(
        availableCredit.add(Money.of('2.75')).add(Money.of('1.25')).toString(),
      );
    }
  });
});

describe('splitClawback', () => {
  it('takes the full net from available when it is sufficient (no receivable)', () => {
    const { fromAvailable, receivable } = splitClawback(Money.of('98'), Money.of('500'));
    expect(fromAvailable.toString()).toBe('98');
    expect(receivable.toString()).toBe('0');
  });

  it('takes exactly net when available equals net', () => {
    const { fromAvailable, receivable } = splitClawback(Money.of('98'), Money.of('98'));
    expect(fromAvailable.toString()).toBe('98');
    expect(receivable.toString()).toBe('0');
  });

  it('caps at available and books the remainder as a receivable (the fraud case)', () => {
    // Company was credited 98 then withdrew it; only 10 remains.
    const { fromAvailable, receivable } = splitClawback(Money.of('98'), Money.of('10'));
    expect(fromAvailable.toString()).toBe('10');
    expect(receivable.toString()).toBe('88');
  });

  it('books the entire net as receivable when available is zero', () => {
    const { fromAvailable, receivable } = splitClawback(Money.of('98'), Money.of('0'));
    expect(fromAvailable.toString()).toBe('0');
    expect(receivable.toString()).toBe('98');
  });

  it('always satisfies fromAvailable + receivable == net (ledger stays balanced)', () => {
    for (const [net, avail] of [
      ['100', '0'],
      ['100', '40'],
      ['100', '100'],
      ['100', '250'],
      ['33.33', '10'],
    ] as const) {
      const { fromAvailable, receivable } = splitClawback(Money.of(net), Money.of(avail));
      expect(fromAvailable.add(receivable).toString()).toBe(Money.of(net).toString());
    }
  });
});
