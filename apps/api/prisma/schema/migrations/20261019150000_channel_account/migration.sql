-- Which provider account a channel token belongs to (LinkedIn member id + name), read at connect time.
-- AlterTable
ALTER TABLE "channel_credentials" ADD COLUMN     "account_id" TEXT,
ADD COLUMN     "account_name" TEXT;

