-- DropForeignKey
ALTER TABLE "notification_reads" DROP CONSTRAINT "notification_reads_notification_id_fkey";

-- DropForeignKey
ALTER TABLE "source_fee_rules" DROP CONSTRAINT "source_fee_rules_source_id_fkey";

-- AlterTable
ALTER TABLE "notification_reads" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "notifications" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "source_fee_rules" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "whish_session_credentials" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "whish_transfers" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "withdrawal_auto_approval_configs" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AddForeignKey
ALTER TABLE "source_fee_rules" ADD CONSTRAINT "source_fee_rules_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_reads" ADD CONSTRAINT "notification_reads_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
