-- AlterTable
ALTER TABLE "Server" ADD COLUMN     "sshHostKey" TEXT,
ADD COLUMN     "sshPort" INTEGER NOT NULL DEFAULT 22;
