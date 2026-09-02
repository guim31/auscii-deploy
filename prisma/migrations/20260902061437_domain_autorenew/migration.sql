-- AlterTable
ALTER TABLE "Domain" ADD COLUMN     "autorenew" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastCheckedAt" TIMESTAMP(3);
