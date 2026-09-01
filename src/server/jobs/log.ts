import type { LogLevel } from "@prisma/client";
import { prisma } from "../db";

export type Logger = {
  info: (message: string, step?: string) => Promise<void>;
  success: (message: string, step?: string) => Promise<void>;
  warn: (message: string, step?: string) => Promise<void>;
  error: (message: string, step?: string) => Promise<void>;
};

export function createLogger(deploymentId: string, defaultStep?: string): Logger {
  const write = async (level: LogLevel, message: string, step?: string) => {
    await prisma.deploymentLog.create({
      data: { deploymentId, level, step: step ?? defaultStep, message },
    });
  };
  return {
    info: (m, s) => write("info", m, s),
    success: (m, s) => write("success", m, s),
    warn: (m, s) => write("warn", m, s),
    error: (m, s) => write("error", m, s),
  };
}
