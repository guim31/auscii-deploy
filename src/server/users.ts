import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { createLocalAccountIssuer } from "@better-auth/core/db";
import { prisma } from "./db";

/** Creates an email + password account directly (public sign-up is disabled). */
export async function createUserWithPassword(input: {
  name: string;
  email: string;
  password: string;
  role: "admin" | "manager";
}) {
  const id = randomUUID();
  return prisma.user.create({
    data: {
      id,
      name: input.name,
      email: input.email.toLowerCase(),
      role: input.role,
      emailVerified: true,
      accounts: {
        create: {
          id: randomUUID(),
          accountId: id,
          providerId: "credential",
          issuer: createLocalAccountIssuer("credential"),
          password: await hashPassword(input.password),
        },
      },
    },
  });
}
