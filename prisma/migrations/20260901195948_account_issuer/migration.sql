-- better-auth 1.7 requires an issuer on every account. Existing rows are credential accounts.
ALTER TABLE "account" ADD COLUMN "issuer" TEXT NOT NULL DEFAULT 'local:credential';
ALTER TABLE "account" ALTER COLUMN "issuer" DROP DEFAULT;
