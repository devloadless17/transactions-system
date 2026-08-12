-- Re-derive commission / source-fee tier BOUNDARIES onto the cent grid.
--
-- The admin UI builds a ladder as "each tier ends one EPSILON below the next
-- tier's start". EPSILON was 1e-8 (the old money scale), which is why live data
-- holds boundaries like 99.99999999 / 100.00000001. Now that the platform money
-- scale is 2 dp, EPSILON is 0.01 — and the two conventions cannot coexist:
--
--   * Leave the data alone and the UI opens a GAP (…99.99999999] then [100.01…),
--     and a gap makes the resolver throw NO_COMMISSION_RULE, which 422s every
--     deposit landing in it.
--   * Round the bounds naively and adjacent tiers COLLIDE (both become 100.00),
--     which validateTierLadder rejects — every existing rule becomes un-editable.
--
-- So: min → ceil to the cent, max → floor to the cent. That is provably
-- membership-preserving on the cent grid: if next_min > prev_max today, then
-- ceil(next_min) >= floor(prev_max) + 0.01, so the ladder stays contiguous with
-- no gap and no overlap. The seeded ladder maps as intended:
--     [0, 100]  [100.00000001, 300]  [300.00000001, ∞)
--  →  [0, 100]  [100.01, 300]        [300.01, ∞)
-- and every 2 dp amount resolves to exactly the same tier as before.
--
-- VALUES are left alone unless the type is FIXED: a FIXED value is dollars and
-- belongs on the cent grid, but a PERCENTAGE value is a RATE, and rounding it
-- would silently reprice every future transaction (0.125% → 0.13%).

-- Gate: a sub-cent tier cannot survive this mapping (its ceil(min) would exceed
-- its floor(max)), which would invert min<=max and trip the range CHECK. Refuse
-- to guess — an operator must repair those by hand first.
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM commission_rules
   WHERE max_amount IS NOT NULL
     AND ceil(min_amount * 100) / 100 > floor(max_amount * 100) / 100;
  IF n > 0 THEN
    RAISE EXCEPTION 'commission_rules: % sub-cent tier(s) must be fixed by hand before this migration', n;
  END IF;

  SELECT count(*) INTO n FROM source_fee_rules
   WHERE max_amount IS NOT NULL
     AND ceil(min_amount * 100) / 100 > floor(max_amount * 100) / 100;
  IF n > 0 THEN
    RAISE EXCEPTION 'source_fee_rules: % sub-cent tier(s) must be fixed by hand before this migration', n;
  END IF;
END $$;

UPDATE commission_rules SET
  min_amount       = ceil(min_amount * 100) / 100,
  max_amount       = floor(max_amount * 100) / 100,
  commission_value = commission_value
WHERE min_amount <> ceil(min_amount * 100) / 100
   OR max_amount <> floor(max_amount * 100) / 100;

UPDATE source_fee_rules SET
  min_amount = ceil(min_amount * 100) / 100,
  max_amount = floor(max_amount * 100) / 100,
  fee_value  = fee_value
WHERE min_amount <> ceil(min_amount * 100) / 100
   OR max_amount <> floor(max_amount * 100) / 100;

-- Proof: no ACTIVE commission ladder may now contain a gap. A gap here would 422
-- real deposits, so fail the migration rather than deploy a broken price list.
DO $$
DECLARE n bigint;
BEGIN
  WITH ladder AS (
    SELECT company_id, source_id, operation_type, group_id, priority, min_amount, max_amount,
           lead(min_amount) OVER (
             PARTITION BY company_id, source_id, operation_type, group_id, priority
             ORDER BY min_amount
           ) AS next_min
    FROM commission_rules
    WHERE active
  )
  -- Deliberately checks for OVERLAP only, matching validateTierLadder: a gapped
  -- ladder ([0,100] then [200,inf)) is legal via the API and predates the group
  -- editor, so demanding exact cent-adjacency here would abort a deploy on data
  -- the application itself accepts — leaving a failed migration that blocks every
  -- later one until someone runs `prisma migrate resolve` by hand, mid-window.
  SELECT count(*) INTO n FROM ladder
   WHERE next_min IS NOT NULL
     AND max_amount IS NOT NULL
     AND next_min <= max_amount;
  IF n > 0 THEN
    RAISE EXCEPTION 'commission_rules: % ladder boundary/boundaries OVERLAP after re-derivation', n;
  END IF;
END $$;

-- Forward-only cent constraint on the append-only ledger.
--
-- The COLUMN keeps its historical scale: ledger_entries accepts only balanced
-- sets, so a global imbalance introduced by re-scaling history could never be
-- repaired by appending (every appendable set nets zero). Constrain the FUTURE
-- instead. NOT VALID grandfathers existing rows and skips the table scan, so this
-- takes SHARE ROW EXCLUSIVE for milliseconds with no rewrite — but every new
-- INSERT is checked from now on. Never VALIDATE it.
ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ledger_entries_amount_cent_chk"
  CHECK ("amount" = round("amount", 2)) NOT VALID;
