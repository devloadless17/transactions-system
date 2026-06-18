-- ============================================================
-- 20260618120000_commission_rule_groups
--
-- Supports the redesigned Commission Rules UI where ONE rule = a set of
-- companies × operations × amount tiers. Each such rule is stored as MANY
-- commission_rules rows sharing a single group_id, so the hot-path resolver,
-- its index and cache are completely unchanged — only the admin CRUD/list layer
-- regroups by group_id.
--
-- (1) group_id: nullable tag linking the rows of one logical rule. Existing rows
--     are backfilled to their own id (each becomes a singleton group), so the
--     list view shows them individually until recreated.
-- (2) max_amount becomes nullable: NULL = "and above" (open-ended top tier, no
--     upper bound) so admins never have to type a giant sentinel number. The
--     range CHECK is relaxed to allow it.
-- ============================================================

-- (1) Group tag + lookup index.
ALTER TABLE "commission_rules" ADD COLUMN "group_id" uuid;
UPDATE "commission_rules" SET "group_id" = "id" WHERE "group_id" IS NULL;
CREATE INDEX "commission_rules_group_id_idx" ON "commission_rules" ("group_id");

-- (2) Open-ended top tier: NULL max_amount = no upper bound.
ALTER TABLE "commission_rules" ALTER COLUMN "max_amount" DROP NOT NULL;
ALTER TABLE "commission_rules" DROP CONSTRAINT "commission_rules_amount_range_chk";
ALTER TABLE "commission_rules" ADD CONSTRAINT "commission_rules_amount_range_chk"
  CHECK ("max_amount" IS NULL OR "min_amount" <= "max_amount");
