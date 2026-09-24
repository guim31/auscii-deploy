/**
 * Creates the first admin account from ADMIN_EMAIL / ADMIN_PASSWORD.
 * Idempotent: an existing account is left untouched.
 *
 * Locally: `pnpm db:seed` (reads .env). On the pilot, install.sh runs it once:
 *   docker compose run --rm --no-deps -e ADMIN_EMAIL -e ADMIN_PASSWORD \
 *     migrate node --import tsx prisma/seed.ts
 * It is never part of `docker compose up`, so a deleted admin stays deleted.
 */
import { config as loadEnv } from "dotenv";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "better-auth/crypto";
import { createLocalAccountIssuer } from "@better-auth/core/db";
import { randomUUID } from "node:crypto";

loadEnv({ quiet: true });

const MIN_PASSWORD_LENGTH = 12;

/** Returns why the password is refused, or null when it is acceptable. */
function passwordIssue(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH)
    return `ADMIN_PASSWORD doit faire au moins ${MIN_PASSWORD_LENGTH} caractères.`;
  if (/change-me/i.test(password))
    return "ADMIN_PASSWORD contient encore la valeur d'exemple « change-me ».";
  return null;
}

async function main() {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD ?? "";
  if (!email || !password) {
    console.log("ADMIN_EMAIL / ADMIN_PASSWORD absents, aucun compte créé.");
    return;
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error(`ADMIN_EMAIL invalide : ${email}`);
  }
  const issue = passwordIssue(password);
  if (issue) throw new Error(issue);

  const prisma = new PrismaClient();
  try {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      console.log(`Compte ${email} déjà présent, inchangé.`);
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
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
