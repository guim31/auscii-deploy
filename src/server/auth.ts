import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { prisma } from "./db";
import { env } from "./env";

export const ROLES = ["admin", "manager"] as const;
export type Role = (typeof ROLES)[number];

export const PASSWORD_MIN_LENGTH = 12;

export const auth = betterAuth({
  baseURL: env().APP_URL,
  secret: env().BETTER_AUTH_SECRET,
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
    minPasswordLength: PASSWORD_MIN_LENGTH,
  },
  // The role lives on the user row; it is only ever changed by the admin actions
  // (never through better-auth endpoints: `input: false`).
  user: {
    additionalFields: {
      role: { type: "string", input: false, defaultValue: "manager", required: false },
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
  },
  trustedOrigins: [env().APP_URL],
  // Slows down password guessing; stored in the database so a restart does not
  // reset the counters. Enabled outside development only.
  rateLimit: {
    enabled: env().NODE_ENV !== "development",
    storage: "database",
    window: 60,
    max: 60,
    customRules: {
      "/sign-in/email": { window: 300, max: 10 },
      "/sign-up/email": { window: 3600, max: 5 },
    },
  },
  // No "admin" plugin: its endpoints (set-role, impersonate, remove-user…) would
  // bypass the guards and the audit log of the admin actions.
  plugins: [nextCookies()],
});

export type Auth = typeof auth;
