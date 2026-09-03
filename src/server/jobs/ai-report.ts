import { prisma } from "../db";
import { getProviders, ProviderNotConfiguredError } from "../providers";
import type { Analysis } from "../releases/analyze";

import { AI_REPORT_FAILED, AI_REPORT_NOT_CONFIGURED } from "@/lib/ai-report";

export type AiReportPayload = { releaseId: string };

/** Asks the AI provider for a short report on a release. Never blocks the wizard. */
export async function generateAiReport({ releaseId }: AiReportPayload): Promise<void> {
  const release = await prisma.release.findUnique({
    where: { id: releaseId },
    include: { site: true },
  });
  if (!release || release.aiReport) return;
  const analysis = release.analysis as Analysis | null;
  if (!analysis) return;
  const providers = await getProviders();
  try {
    const report = await providers.ai.analyzeSite({
      clientName: release.site.clientName,
      files: analysis.pages.map((p) => ({ path: p.path, size: 0 })),
      pages: analysis.pages.map((p) => ({ path: p.path, title: p.title, text: p.text })),
      facts: analysis.issues.map((i) => i.message),
    });
    await prisma.release.update({ where: { id: releaseId }, data: { aiReport: report } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const notConfigured = err instanceof ProviderNotConfiguredError;
    if (!notConfigured) console.error(`[ai.report] ${releaseId}:`, message);
    await prisma.release.update({
      where: { id: releaseId },
      data: {
        aiReport: {
          summary: notConfigured
            ? `Rapport Claude non généré : ${message}`
            : `Analyse indisponible : ${message}`,
          seo: [],
          accessibility: [],
          content: [],
          generatedBy: notConfigured ? AI_REPORT_NOT_CONFIGURED : AI_REPORT_FAILED,
        },
      },
    });
  }
}
