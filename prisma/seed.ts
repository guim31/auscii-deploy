/**
 * Creates the first admin account from ADMIN_EMAIL / ADMIN_PASSWORD.
 * Idempotent: an existing account is left untouched.
 */
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "better-auth/crypto";
import { createLocalAccountIssuer } from "@better-auth/core/db";
import { randomUUID } from "node:crypto";

const prisma = new PrismaClient();

async function main() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    console.log("ADMIN_EMAIL / ADMIN_PASSWORD absents, aucun compte créé.");
    return;
  }
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log(`Compte ${email} déjà présent.`);
    return;
  }
  const id = randomUUID();
  await prisma.user.create({
    data: {
      id,
      email,
      name: email.split("@")[0],
      role: "admin",
      emailVerified: true,
      accounts: {
        create: {
          id: randomUUID(),
          accountId: id,
          providerId: "credential",
          issuer: createLocalAccountIssuer("credential"),
          password: await hashPassword(password),
        },
      },
    },
  });
  console.log(`Compte admin ${email} créé.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
