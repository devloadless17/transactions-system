# Money-scale migration runbook (Stages A′ and B)

> ## ⛔ HARD PRECONDITION — read before deploying the code
>
> **Every in-flight row carrying an over-scale reservation must be settled or
> cancelled BEFORE the money scale is flipped.** Not before Stage B — before the
> code deploy itself.
>
> A reservation booked at, say, `100.015` cannot be drained once the scale is 2 dp:
> draining it exactly needs an over-scale ledger leg (which `writeEntries` refuses
> by design), and draining a quantized amount takes more than was ever reserved, so
> the wallet guard rejects it. The row can then be neither approved nor rejected nor
> cancelled, and the company's funds stay locked. **There is no code fix — the
> arithmetic does not permit one.** It fails safely (nothing is written, the books
> stay balanced), but it fails permanently.
>
> This is pinned by `apps/api/test/integration/money-scale-legacy.int-spec.ts`
> ("proves the drain gate is required"). Run the drain query in §4 below and clear
> every hit first.

The code half is written: nothing new is written with more than 2 decimals, and
legacy over-scale rows are quantized on read so they still settle — with the one
exception above. What remains is the **data** half, which needs a prod replica, a
maintenance window, and your hands on it.

Read `docs/MONEY_SCALE.md` first for the rule and why the ledger is exempt.

**Do not start Stage B before Stage A has soaked in production.** Nothing here is
urgent: the system is already correct at cent scale with the wider columns.

---

## Stage A′ — audit and drain (read-only, no code)

Run everything here on a **prod replica**, not on prod.

### 1. How much legacy over-scale data is there?

`x <> round(x,2)` is independent of the declared column scale, so it works
before any type change.

```sql
SELECT 'ledger_entries.amount' c, count(*) n FROM ledger_entries WHERE amount <> round(amount,2)
UNION ALL SELECT 'transactions.amount',            count(*) FROM transactions WHERE amount            <> round(amount,2)
UNION ALL SELECT 'transactions.commission_amount', count(*) FROM transactions WHERE commission_amount <> round(commission_amount,2)
UNION ALL SELECT 'transactions.net_amount',        count(*) FROM transactions WHERE net_amount        <> round(net_amount,2)
UNION ALL SELECT 'transactions.source_fee_amount', count(*) FROM transactions WHERE source_fee_amount <> round(source_fee_amount,2)
UNION ALL SELECT 'wallets.available',  count(*) FROM wallets WHERE available_balance <> round(available_balance,2)
UNION ALL SELECT 'wallets.pending',    count(*) FROM wallets WHERE pending_balance   <> round(pending_balance,2)
UNION ALL SELECT 'wallets.reserved',   count(*) FROM wallets WHERE reserved_balance  <> round(reserved_balance,2)
UNION ALL SELECT 'withdrawals.*', count(*) FROM withdrawals
   WHERE amount<>round(amount,2) OR fee_amount<>round(fee_amount,2)
      OR net_amount<>round(net_amount,2) OR rounding_remainder<>round(rounding_remainder,2)
UNION ALL SELECT 'payouts.*', count(*) FROM payouts
   WHERE amount<>round(amount,2) OR fee_amount<>round(fee_amount,2) OR net_amount<>round(net_amount,2)
UNION ALL SELECT 'loads.*', count(*) FROM loads
   WHERE amount<>round(amount,2) OR fee_amount<>round(fee_amount,2) OR net_amount<>round(net_amount,2)
UNION ALL SELECT 'whish_payments.amount',  count(*) FROM whish_payments  WHERE amount <> round(amount,2)
UNION ALL SELECT 'whish_transfers.amount', count(*) FROM whish_transfers WHERE amount <> round(amount,2)
ORDER BY 2 DESC;
```

### 2. Would anything round to ZERO?

`ALTER TABLE ... TYPE` re-validates CHECK constraints during its rewrite, so a
row that rounds to `0` under an `amount > 0` CHECK aborts the whole statement.

```sql
SELECT 'transactions' t, count(*) FROM transactions   WHERE amount > 0 AND round(amount,2) = 0
UNION ALL SELECT 'withdrawals', count(*) FROM withdrawals    WHERE amount > 0 AND round(amount,2) = 0
UNION ALL SELECT 'payouts',     count(*) FROM payouts        WHERE amount > 0 AND round(amount,2) = 0
UNION ALL SELECT 'loads',       count(*) FROM loads          WHERE amount > 0 AND round(amount,2) = 0
UNION ALL SELECT 'whish_pay',   count(*) FROM whish_payments WHERE amount > 0 AND round(amount,2) = 0;
```

Every hit must be remediated by hand before Stage B.

### 3. THE KILLER QUERY — is the ledger safe to re-scale at all?

```sql
SELECT currency,
  SUM(CASE WHEN direction='DEBIT' THEN amount          ELSE -amount          END) AS net_now,
  SUM(CASE WHEN direction='DEBIT' THEN round(amount,2) ELSE -round(amount,2) END) AS net_post
FROM ledger_entries GROUP BY currency;
```

`net_now` must be `0` today. **If `net_post` is non-zero for any currency, the
ledger column can never be migrated** — `ledger_entries` accepts only balanced
sets, so appending compensating entries can never change a global imbalance, and
the only alternative would be rewriting append-only history. That is why the
plan keeps `ledger_entries.amount` and `wallets.*` at `numeric(20,8)`.

Also check receivables specifically — a residue here permanently blocks a
company's money-out with no code path to clear it:

```sql
SELECT company_id, currency,
  SUM(CASE WHEN direction='DEBIT' THEN amount          ELSE -amount          END) AS owed_now,
  SUM(CASE WHEN direction='DEBIT' THEN round(amount,2) ELSE -round(amount,2) END) AS owed_post
FROM ledger_entries WHERE account_type='RECEIVABLE' GROUP BY 1,2
HAVING SUM(CASE WHEN direction='DEBIT' THEN round(amount,2) ELSE -round(amount,2) END) <> 0;
```

### 4. Drain the in-flight rows — a hard gate

A row reserved at 8dp and settled from 2dp columns will not reconcile: `reserved`
goes negative and the withdrawal wedges. Settle or cancel anything this returns
before Stage B.

```sql
-- Catch ANY over-scale component, not just a broken net identity: `reserved` is
-- amount (DEDUCTED) or amount+fee (ON_TOP), so an over-scale `amount` alone is
-- enough to wedge the row.
SELECT id, status, amount, fee_amount, net_amount, fee_application FROM withdrawals
 WHERE status IN ('PENDING','PROCESSING')
   AND (amount <> round(amount,2)
     OR fee_amount <> round(fee_amount,2)
     OR net_amount <> round(net_amount,2));
-- repeat for payouts and loads (status='PENDING')
SELECT count(*) FROM whish_payments WHERE status='PENDING' AND amount <> round(amount,2);
```

### 5. Before scheduling the window

- `pg_dump -Fc` restore **rehearsed on staging**, with a measured RTO you accept.
- Table sizing (`pg_total_relation_size`) — the rewrite needs a full second copy
  on disk, so free space must be ≥ 2× the largest table being rewritten.

---

## Stage B — quantize, then ALTER

Maintenance window, API stopped. The ordering exists so that the lossy cast is a
**provable no-op**: quantize first, verify nothing changes, then change the type.

1. Fresh `pg_dump -Fc`, checksummed, off-host.
2. `CREATE SCHEMA money_scale_backup_v1` and snapshot every column being touched,
   **before** any UPDATE. This is the practical rollback.
3. **Quantize in place.** Round the _inputs_ and **derive** dependents (`net` from
   `amount − fee`, using the explicit `fee_application` column) rather than
   rounding each independently — that is what keeps the CHECK constraints
   satisfied. `max_auto_approve_amount` uses `floor`, never widening a cap.
   **Do not quantize `wallets`** — they must keep their tail to match the ledger.
   Every statement is `WHERE x <> round(x,2)`, so it is idempotent.
4. **`ALTER COLUMN … TYPE numeric(20,2)`**, one `ALTER TABLE` per table (multiple
   clauses = one rewrite), smallest first: configs → fee rules → commission rules
   → whish_transfers → loads/payouts → withdrawals → whish_payments →
   **transactions** (the one to plan for). Set `lock_timeout` /
   `statement_timeout` inside the migration: `packages/db/deploy.sh` pins
   `lock_timeout=5000`, far too short for a rewrite.
5. **Between each wave**, diff against `money_scale_backup_v1`: **zero values may
   have changed.** Non-zero means the quantize step was incomplete — stop,
   restore that table, abort the window.
6. `prisma generate`, rebuild the API image (Prisma's Decimal handling is
   schema-driven), restart, then force a full reconcile and confirm
   `divergentCount == 0`.

`ledger_entries` is **not** migrated. It gets a forward-only constraint instead,
which costs a millisecond and no rewrite:

```sql
ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ledger_entries_amount_cent_chk"
  CHECK ("amount" = round("amount", 2)) NOT VALID;
```

`NOT VALID` grandfathers existing rows and skips the scan; every new INSERT is
still checked. Never `VALIDATE` it.

### Rollback, stated plainly

**`ALTER COLUMN … TYPE numeric(20,2)` is lossy and cannot be undone.** Re-widening
restores the type, never the digits. The rollback is the backup: the dump, the
`money_scale_backup_v1` schema, and a tagged pre-B image. Keep the backup schema
for 30 days of green reconciliation.
