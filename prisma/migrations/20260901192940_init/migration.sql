-- CreateEnum
CREATE TYPE "ServerStatus" AS ENUM ('ordering', 'bootstrapping', 'ready', 'error', 'retired');

-- CreateEnum
CREATE TYPE "SiteStatus" AS ENUM ('draft', 'provisioning', 'ready', 'preview', 'live', 'error');

-- CreateEnum
CREATE TYPE "SiteRuntime" AS ENUM ('static', 'docker');

-- CreateEnum
CREATE TYPE "DomainOrderStatus" AS ENUM ('none', 'pending', 'registered', 'failed');

-- CreateEnum
CREATE TYPE "DeployKind" AS ENUM ('provision', 'deploy', 'promote', 'rollback');

-- CreateEnum
CREATE TYPE "DeployEnv" AS ENUM ('staging', 'production');

-- CreateEnum
CREATE TYPE "DeployStatus" AS ENUM ('queued', 'running', 'succeeded', 'failed');

-- CreateEnum
CREATE TYPE "LogLevel" AS ENUM ('info', 'success', 'warn', 'error');

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "role" TEXT NOT NULL DEFAULT 'manager',
    "banned" BOOLEAN NOT NULL DEFAULT false,
    "banReason" TEXT,
    "banExpires" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "impersonatedBy" TEXT,
    "userId" TEXT NOT NULL,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3),

    CONSTRAINT "verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "Integration" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "encrypted" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastTestAt" TIMESTAMP(3),
    "lastTestOk" BOOLEAN,

    CONSTRAINT "Integration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Server" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'scaleway',
    "providerId" TEXT,
    "ip" TEXT,
    "sshUser" TEXT NOT NULL DEFAULT 'deploy',
    "status" "ServerStatus" NOT NULL DEFAULT 'ordering',
    "offer" TEXT NOT NULL,
    "zone" TEXT NOT NULL DEFAULT 'fr-par-1',
    "vcpus" INTEGER NOT NULL DEFAULT 2,
    "monthlyPrice" DOUBLE PRECISION,
    "metrics" JSONB,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Server_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Site" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "clientName" TEXT NOT NULL,
    "domain" TEXT,
    "previewHost" TEXT,
    "previewToken" TEXT NOT NULL,
    "formsEmail" TEXT,
    "runtime" "SiteRuntime" NOT NULL DEFAULT 'static',
    "status" "SiteStatus" NOT NULL DEFAULT 'draft',
    "serverId" TEXT,
    "gitRepo" TEXT,
    "screenshotPath" TEXT,
    "stagingReleaseId" TEXT,
    "liveReleaseId" TEXT,
    "lastPublishedAt" TIMESTAMP(3),
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Site_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Domain" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "fqdn" TEXT NOT NULL,
    "registrar" TEXT NOT NULL DEFAULT 'gandi',
    "owned" BOOLEAN NOT NULL DEFAULT false,
    "orderId" TEXT,
    "orderStatus" "DomainOrderStatus" NOT NULL DEFAULT 'none',
    "price" DOUBLE PRECISION,
    "currency" TEXT,
    "expiresAt" TIMESTAMP(3),
    "dnsConfigured" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Domain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Release" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "commitSha" TEXT,
    "gitTag" TEXT,
    "archiveHash" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "fileCount" INTEGER NOT NULL,
    "analysis" JSONB,
    "aiReport" JSONB,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Release_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deployment" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "releaseId" TEXT,
    "kind" "DeployKind" NOT NULL,
    "environment" "DeployEnv",
    "status" "DeployStatus" NOT NULL DEFAULT 'queued',
    "steps" JSONB NOT NULL DEFAULT '[]',
    "error" TEXT,
    "rollbackOfId" TEXT,
    "triggeredById" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Deployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeploymentLog" (
    "id" SERIAL NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "level" "LogLevel" NOT NULL DEFAULT 'info',
    "step" TEXT,
    "message" TEXT NOT NULL,

    CONSTRAINT "DeploymentLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FormSubmission" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "fromIp" TEXT,
    "emailedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FormSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SslCheck" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "issuer" TEXT,
    "expiresAt" TIMESTAMP(3),
    "error" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SslCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "userEmail" TEXT,
    "action" TEXT NOT NULL,
    "target" TEXT,
    "amount" DOUBLE PRECISION,
    "currency" TEXT,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_key" ON "session"("token");

-- CreateIndex
CREATE INDEX "session_userId_idx" ON "session"("userId");

-- CreateIndex
CREATE INDEX "account_userId_idx" ON "account"("userId");

-- CreateIndex
CREATE INDEX "verification_identifier_idx" ON "verification"("identifier");

-- CreateIndex
CREATE UNIQUE INDEX "Integration_provider_key" ON "Integration"("provider");

-- CreateIndex
CREATE UNIQUE INDEX "Server_name_key" ON "Server"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Site_slug_key" ON "Site"("slug");

-- CreateIndex
CREATE INDEX "Site_status_idx" ON "Site"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Domain_siteId_key" ON "Domain"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "Release_siteId_version_key" ON "Release"("siteId", "version");

-- CreateIndex
CREATE INDEX "Deployment_siteId_createdAt_idx" ON "Deployment"("siteId", "createdAt");

-- CreateIndex
CREATE INDEX "DeploymentLog_deploymentId_id_idx" ON "DeploymentLog"("deploymentId", "id");

-- CreateIndex
CREATE INDEX "FormSubmission_siteId_createdAt_idx" ON "FormSubmission"("siteId", "createdAt");

-- CreateIndex
CREATE INDEX "SslCheck_siteId_checkedAt_idx" ON "SslCheck"("siteId", "checkedAt");

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Site" ADD CONSTRAINT "Site_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Domain" ADD CONSTRAINT "Domain_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Release" ADD CONSTRAINT "Release_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "Release"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentLog" ADD CONSTRAINT "DeploymentLog_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormSubmission" ADD CONSTRAINT "FormSubmission_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SslCheck" ADD CONSTRAINT "SslCheck_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
