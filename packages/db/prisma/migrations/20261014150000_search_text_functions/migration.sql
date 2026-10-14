-- =================================================================
-- 20261014150000_search_text_functions
--
-- One search rule for every money list (apps/api/src/common/search.ts): a row
-- is found by ANY field a person would quote — its id, reference, note, and
-- every detail of who it was for (name, phone, account, wallet…) — and a phone
-- by its digits however it is typed. Searching those as separate ORed fields
-- walks the whole table (measured at 27x production: 3.2s for a phone over
-- 525k deposits), so each table gets two trigram indexes (the next four
-- migrations) on the expressions below: its search text, and its phone digits.
-- The queries call these exact functions, which is what lets them use those
-- indexes (21ms for the same search).
--
-- IMMUTABLE: they read only their arguments. The phone digits keep '|' between
-- fields, so a match can never span two numbers.
--
-- LEAKPROOF — and LIKE / ILIKE themselves (textlike, texticlike) — because of
-- row-level security: the app's role reads these tables under RLS, and Postgres
-- only lets a condition use an index AHEAD of the RLS policy when every
-- function in it is leakproof (cannot reveal anything about a row the caller
-- may not see). Without it the search falls back to walking the table even
-- with the indexes (measured as the app's role at 27x production: 1,764ms vs
-- 28ms). The RLS policy is still applied to every row returned — this changes
-- the plan, not who can see what. They qualify: ours read only their arguments
-- and never raise (jsonb_each_text only ever sees an object), and LIKE/ILIKE can
-- only error on a malformed PATTERN (the search itself, the same for every
-- row), never because of a row's data.
--
-- textlike/texticlike are built-ins, whose flags a backup restore does not
-- carry over: packages/db/deploy.sh re-applies them on every deploy.
--
-- SET search_path on each: pins what they resolve (good practice for anything
-- an index stores), AND stops Postgres inlining them — an inlined body is
-- judged by ITS functions (regexp_replace is not leakproof), which loses the
-- LEAKPROOF above and the index under RLS (measured: flow_search_phones, a
-- single expression, was inlined and fell back to a full scan).
--
-- Catalog-only: no table is touched. pg_trgm has been installed since 0024.
-- The previous API version never calls these, so it keeps working while this
-- runs, and a rollback ignores them.
-- =================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- A deposit: our id, the source's reference, and the documented payload fields
-- (customer, target, phone, note) — never nested provider objects, which would
-- match their own key names.
CREATE OR REPLACE FUNCTION deposit_search_text(id uuid, ref text, payload jsonb)
RETURNS text LANGUAGE sql IMMUTABLE LEAKPROOF PARALLEL SAFE
SET search_path = pg_catalog, pg_temp AS $$
  SELECT concat_ws(' ', id::text, ref, payload->>'customer', payload->>'target',
                   payload->>'phone', payload->>'note')
$$;

-- A deposit's phone digits: the payer's phone, and `customer` (some sources send
-- the phone there).
CREATE OR REPLACE FUNCTION deposit_search_phones(payload jsonb)
RETURNS text LANGUAGE sql IMMUTABLE LEAKPROOF PARALLEL SAFE
SET search_path = pg_catalog, pg_temp AS $$
  SELECT regexp_replace(concat_ws('|', payload->>'phone', payload->>'customer'), '[^0-9|]', '', 'g')
$$;

-- A withdrawal / payout / load: our id, the external reference, the company's
-- note, and EVERY value of its payout details (whatever the method carries, so
-- a new method is searchable with no change here). Never admin_notes.
CREATE OR REPLACE FUNCTION flow_search_text(id uuid, ref text, notes text, details jsonb)
RETURNS text LANGUAGE sql IMMUTABLE LEAKPROOF PARALLEL SAFE
SET search_path = pg_catalog, pg_temp AS $$
  SELECT concat_ws(' ', id::text, ref, notes,
    (SELECT string_agg(d.value, ' ')
       FROM jsonb_each_text(CASE WHEN jsonb_typeof(details) = 'object' THEN details END) d))
$$;

-- A withdrawal / payout / load's phone digits: the recipient's phone.
CREATE OR REPLACE FUNCTION flow_search_phones(details jsonb)
RETURNS text LANGUAGE sql IMMUTABLE LEAKPROOF PARALLEL SAFE
SET search_path = pg_catalog, pg_temp AS $$
  SELECT regexp_replace(COALESCE(details->>'recipientPhone', ''), '[^0-9]', '', 'g')
$$;

-- LIKE / ILIKE: leakproof, so a search can use the indexes under RLS (above).
ALTER FUNCTION textlike(text, text) LEAKPROOF;
ALTER FUNCTION texticlike(text, text) LEAKPROOF;
