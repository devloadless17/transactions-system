import { describe, expect, it } from 'vitest';
import { ValidationError } from './errors/domain.error';
import {
  depositSearchSql,
  flowSearchSql,
  MAX_SEARCH_MATCHES,
  searchIds,
  searchTerm,
} from './search';

describe('searchTerm — what an operator types', () => {
  it('a phone typed any way becomes its digits, leading zeros dropped', () => {
    for (const typed of ['+96170977661', '+961 70 977 661', '0096170977661', '961-70-977-661']) {
      expect(searchTerm(typed).digits).toBe('%96170977661%');
    }
    expect(searchTerm('70977661').digits).toBe('%70977661%'); // local, no country code
    expect(searchTerm('03 123 456').digits).toBe('%3123456%'); // national 0 dropped
    expect(searchTerm('(70) 977.661').digits).toBe('%70977661%');
  });

  it('too few digits, or anything not phone-like, is matched as text only', () => {
    expect(searchTerm('961').digits).toBeNull();
    expect(searchTerm('Hamza Badran').digits).toBeNull();
    expect(searchTerm('wt_kJPZzzKjyUmg').digits).toBeNull();
    expect(searchTerm('531d3c17').digits).toBeNull();
  });

  it('trims, and takes LIKE wildcards literally', () => {
    expect(searchTerm('  hamza  ').like).toBe('%hamza%');
    expect(searchTerm('50%').like).toBe('%50\\%%');
    expect(searchTerm('wt_kJ').like).toBe('%wt\\_kJ%');
    expect(searchTerm('a\\b').like).toBe('%a\\\\b%');
  });
});

describe('the SQL predicates bind values, never interpolate them', () => {
  it('a flow row matches by every payout detail and, for phones, by digits', () => {
    const sql = flowSearchSql('$1', '$2');
    expect(sql).toContain('jsonb_each_text');
    expect(sql).toContain("o.payout_details->>'recipientPhone'");
    expect(sql).toContain('LIKE $2');
    expect(sql).not.toContain('admin_notes'); // a company must not probe admin notes
    expect(flowSearchSql('$1', null)).not.toContain('regexp_replace');
  });

  it('a deposit row matches by its documented payload fields, the reference and the id', () => {
    const sql = depositSearchSql('$1', '$2', 's.code');
    for (const field of ['customer', 'target', 'phone', 'note']) {
      expect(sql).toContain(`o.payload->>'${field}' ILIKE $1`);
    }
    expect(sql).toContain('o.external_transaction_id ILIKE $1');
    expect(sql).toContain('s.code ILIKE $1');
    expect(depositSearchSql('$1', null)).not.toContain('s.code');
  });
});

describe('searchIds — the ids a list narrows to', () => {
  const fakeTx = (rows: number) => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    return {
      calls,
      tx: {
        async $queryRawUnsafe<T>(sql: string, ...values: unknown[]): Promise<T> {
          calls.push({ sql, values });
          return Array.from({ length: rows }, (_, i) => ({ id: `id-${i}` })) as T;
        },
      },
    };
  };

  it('binds the search and the company, and returns the ids', async () => {
    const { tx, calls } = fakeTx(2);
    await expect(searchIds(tx, 'withdrawals', '+961 70 977 661', 'co-1')).resolves.toEqual([
      'id-0',
      'id-1',
    ]);
    expect(calls[0]!.sql).toMatch(/FROM withdrawals o WHERE/);
    expect(calls[0]!.values).toEqual([
      '%+961 70 977 661%',
      '%96170977661%',
      'co-1',
      MAX_SEARCH_MATCHES + 1,
    ]);
  });

  it('deposits use the deposit predicate', async () => {
    const { tx, calls } = fakeTx(0);
    await searchIds(tx, 'transactions', 'ali');
    expect(calls[0]!.sql).toMatch(/FROM transactions o WHERE/);
    expect(calls[0]!.sql).toContain("o.payload->>'customer'");
  });

  it('a search matching more rows than a list can narrow to asks for more characters', async () => {
    const { tx } = fakeTx(MAX_SEARCH_MATCHES + 1);
    await expect(searchIds(tx, 'payouts', '1')).rejects.toThrow(ValidationError);
    await expect(searchIds(tx, 'payouts', '1')).rejects.toThrow(/type a few more characters/);
  });
});
