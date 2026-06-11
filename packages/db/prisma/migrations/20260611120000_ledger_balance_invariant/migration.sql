-- Defense-in-depth backstop for the core double-entry invariant.
--
-- LedgerService.writeEntries already guarantees, in application code, that every
-- set of ledger lines it writes balances per currency (SUM(DEBIT) == SUM(CREDIT))
-- and inserts the whole set as one createMany (a single multi-row INSERT). This
-- trigger re-checks exactly that invariant at the database, over the rows of each
-- INSERT statement, as a last line of defence: a future code path, a bug, or a
-- direct write that ever booked an unbalanced set is rejected outright instead of
-- silently corrupting the books.
--
-- Safety: it checks precisely what the app already enforces — the same persisted
-- 8dp amounts, grouped per currency, per write — so it can only fire on a write
-- the application itself would have rejected. It therefore cannot break any
-- legitimate money flow (proven by the integration suite running against it).
-- AFTER INSERT only; the append-only UPDATE/DELETE guards from 0002 are untouched.

CREATE OR REPLACE FUNCTION assert_ledger_set_balanced() RETURNS TRIGGER AS $$
DECLARE
  bad RECORD;
BEGIN
  FOR bad IN
    SELECT currency,
           SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END) AS net
    FROM new_rows
    GROUP BY currency
    HAVING SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END) <> 0
  LOOP
    RAISE EXCEPTION
      'ledger imbalance: lines for currency % do not balance (net debit-credit = %)',
      bad.currency, bad.net;
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_balanced
  AFTER INSERT ON "ledger_entries"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT
  EXECUTE FUNCTION assert_ledger_set_balanced();
