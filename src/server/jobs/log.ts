import type { LogLevel } from "@prisma/client";
import { prisma } from "../db";

export type Logger = {
  info: (message: string, step?: string) => Promise<void>;
  success: (message: string, step?: string) => Promise<void>;
  warn: (message: string, step?: string) => Promise<void>;
  error: (message: string, step?: string) => Promise<void>;
};

const SECRET_PATTERNS: [RegExp, string][] = [
  [/x-access-token:[^@\s]+@/gi, "x-access-token:***@"],
  [/\bgh[opsu]_[A-Za-z0-9]{20,}/g, "gh*_***"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "github_pat_***"],
  [/(authorization:\s*(?:basic|bearer)\s+)[A-Za-z0-9._~+/=-]+/gi, "$1***"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, "Bearer ***"],
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/g, "sk-ant-***"],
  [/\bre_[A-Za-z0-9]{16,}/g, "re_***"],
];

/**
 * Masks anything that looks like a credential. Deployment logs, errors and
 * alert emails carry provider messages, which must never leak a token.
 */
export function redactSecrets(message: string): string {
  return SECRET_PATTERNS.reduce((m, [re, by]) => m.replace(re, by), message);
}

export function createLogger(deploymentId: string, defaultStep?: string): Logger {
  const write = async (level: LogLevel, message: string, step?: string) => {
    await prisma.deploymentLog.create({
      data: { deploymentId, level, step: step ?? defaultStep, message: redactSecrets(message) },
    });
  };
  return {
    info: (m, s) => write("info", m, s),
    success: (m, s) => write("success", m, s),
    warn: (m, s) => write("warn", m, s),
    error: (m, s) => write("error", m, s),
  };
}

/** Logger for jobs that are not attached to a deployment (server order, bootstrap…). */
export function consoleLogger(prefix: string): Logger {
  return {
    info: async (m) => console.log(prefix, redactSecrets(m)),
    success: async (m) => console.log(prefix, redactSecrets(m)),
    warn: async (m) => console.warn(prefix, redactSecrets(m)),
    error: async (m) => console.error(prefix, redactSecrets(m)),
  };
}
