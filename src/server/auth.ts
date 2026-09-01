import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { admin } from "better-auth/plugins";
import { prisma } from "./db";
import { env } from "./env";

export const ROLES = ["admin", "manager"] as const;
export type Role = (typeof ROLES)[number];

export const auth = betterAuth({
  baseURL: env().APP_URL,
  secret: env().BETTER_AUTH_SECRET,
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
    minPasswordLength: 8,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 14,
    updateAge: 60 * 60 * 24,
  },
  plugins: [admin({ defaultRole: "manager", adminRoles: ["admin"] }), nextCookies()],
});

export type Auth = typeof auth;
