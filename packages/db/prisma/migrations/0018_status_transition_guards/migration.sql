-- =================================================================
-- 0018_status_transition_guards
--
-- Defense-in-depth for the money-state machines. The application already
-- checks status before each transition, but nothing at the DB level stops an
-- illegal move (a bug, a bad migration, or direct SQL reviving a settled row).
--
-- Conservative rule: a row may not leave a TERMINAL status. Forward
-- transitions are unconstrained (the app owns those); only resurrecting a
-- finalized record is rejected.
--   transactions:                 REVERSED / REFUNDED / FAILED are terminal
--   withdrawals/payouts/loads:    COMPLETED / REJECTED / CANCELLED are terminal
-- =================================================================

CREATE OR REPLACE FUNCTION reject_terminal_status_change() RETURNS TRIGGER AS $$
DECLARE
  terminal TEXT[];
BEGIN
  -- Only care about actual status changes.
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  terminal := CASE TG_TABLE_NAME
    WHEN 'transactions' THEN ARRAY['REVERSED', 'REFUNDED', 'FAILED']
    ELSE ARRAY['COMPLETED', 'REJECTED', 'CANCELLED'] -- withdrawals / payouts / loads
  END;

  IF OLD.status::text = ANY(terminal) THEN
    RAISE EXCEPTION 'Illegal status transition on %: % is terminal (attempted -> %)',
      TG_TABLE_NAME, OLD.status, NEW.status;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER transactions_status_guard
  BEFORE UPDATE ON "transactions"
  FOR EACH ROW EXECUTE FUNCTION reject_terminal_status_change();

CREATE TRIGGER withdrawals_status_guard
  BEFORE UPDATE ON "withdrawals"
  FOR EACH ROW EXECUTE FUNCTION reject_terminal_status_change();

CREATE TRIGGER payouts_status_guard
  BEFORE UPDATE ON "payouts"
  FOR EACH ROW EXECUTE FUNCTION reject_terminal_status_change();

CREATE TRIGGER loads_status_guard
  BEFORE UPDATE ON "loads"
  FOR EACH ROW EXECUTE FUNCTION reject_terminal_status_change();
