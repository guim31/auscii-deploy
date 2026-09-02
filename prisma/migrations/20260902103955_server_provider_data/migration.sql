-- AlterEnum
ALTER TYPE "ServerStatus" ADD VALUE 'retiring';

-- AlterTable
ALTER TABLE "Server" ADD COLUMN     "providerData" JSONB;
