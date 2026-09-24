-- AlterEnum
ALTER TYPE "DomainOrderStatus" ADD VALUE 'ordering';

-- AlterTable
ALTER TABLE "Deployment" ADD COLUMN     "domainPurchaseConfirmedById" TEXT,
ADD COLUMN     "serverOrderConfirmedById" TEXT,
ADD COLUMN     "serverOrderMaxPrice" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "Server" ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "unreachableSince" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "Site_isDemo_status_idx" ON "Site"("isDemo", "status");
