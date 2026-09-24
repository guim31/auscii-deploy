import { prisma } from "../db";
import { analyzeSite, type Analysis } from "./analyze";
import { canFixForms, fixForms, listSiteFiles, type FixFormsResult } from "./fix-forms";
import { releaseDir } from "./paths";

export class FixFormsRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixFormsRefusedError";
  }
}

/**
 * "Corriger les formulaires" for one release: refuses a release already pushed
 * or deployed, rewires the forms, re-analyses the files (keeping what the
 * extraction reported) and stores the new analysis.
 */
export async function fixReleaseForms(
  releaseId: string,
): Promise<FixFormsResult & { analysis: Analysis }> {
  const release = await prisma.release.findUnique({
    where: { id: releaseId },
    include: {
      site: { select: { formsEmail: true, stagingReleaseId: true, liveReleaseId: true } },
      _count: { select: { deployments: true } },
    },
  });
  if (!release) throw new FixFormsRefusedError("Version introuvable.");
  const check = canFixForms({
    commitSha: release.commitSha,
    deploymentCount: release._count.deployments,
    inUse: release.site.stagingReleaseId === releaseId || release.site.liveReleaseId === releaseId,
  });
  if (!check.ok) throw new FixFormsRefusedError(check.error);

  const dir = releaseDir(releaseId);
  const files = await listSiteFiles(dir);
  const result = await fixForms(dir, files);
  const previous = release.analysis as Analysis | null;
  const analysis = await analyzeSite(dir, files, {
    formsEmail: release.site.formsEmail,
    intake: previous?.skippedFiles
      ? { skipped: previous.skippedFiles, strippedRoot: previous.siteRoot ?? null }
      : undefined,
  });
  if (result.skipped.length)
    analysis.issues.unshift({
      level: "warn",
      message: `Formulaires non corrigés automatiquement : ${result.skipped
        .map((s) => `${s.path} (${s.reason})`)
        .join(", ")}.`,
    });
  await prisma.release.update({
    where: { id: releaseId },
    data: { analysis: analysis as object, fileCount: files.length },
  });
  return { ...result, analysis };
}
