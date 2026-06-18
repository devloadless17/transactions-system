-- Optional admin-facing label for a commission rule (shared across the group's
-- rows). Display only — never used in pricing.
ALTER TABLE "commission_rules" ADD COLUMN "name" text;
