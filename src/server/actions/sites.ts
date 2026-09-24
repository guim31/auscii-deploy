"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Prisma, type Site } from "@prisma/client";
import { prisma } from "../db";
import { getCurrentUser } from "../session";
import { audit } from "../audit";
import { getProviders, ProviderNotConfiguredError, type DomainAvailability } from "../providers";
import { createDraftSite, placementForSite, saveStep1 } from "../sites";
import { getSettings, isReservedDomain } from "../settings";
import { matchesCurrentMode, OTHER_MODE_ERROR } from "../mode";
import { rm } from "node:fs/promises";
import { isValidFqdn, normalizeFqdn } from "@/lib/slug";
import {
  DeploymentBusyError,
  retryDeployment,
  startProvision,
  startPromote,
  startRollback,
  startStagingDeploy,
} from "../jobs/pipelines";
import type { AiReport } from "../providers/types";
import { analyzeSite, type Analysis } from "../releases/analyze";
import { fixForms, listSiteFiles } from "../releases/fix-forms";
import { releaseDir } from "../releases/paths";
import { queueSubmissionMail } from "../jobs/mail";
import { enqueue, QUEUES } from "../jobs/boss";
import { aiReportRetryable } from "@/lib/ai-report";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

function errorMessage(err: unknown): string {
  if (err instanceof ProviderNotConfiguredError || err instanceof DeploymentBusyError)
    return err.message;
  return err instanceof Error ? err.message : "Erreur inattendue";
}

export async function createSiteAction(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const clientName = String(formData.get("clientName") ?? "").trim();
  if (clientName.length < 2 || clientName.length > 80) redirect("/deploy/new?error=nom");
  const site = await createDraftSite(user.id, clientName);
  redirect(`/deploy/${site.id}/step-1`);
}

/** Loads a site of the current mode, or explains why it cannot be acted upon. */
async function siteForAction(
  siteId: string,
): Promise<{ ok: false; error: string } | { ok: true; site: Site }> {
  if (typeof siteId !== "string") return { ok: false, error: "Site introuvable" };
  const site = await prisma.site.findUnique({ where: { id: siteId } });
  if (!site) return { ok: false, error: "Site introuvable" };
  if (!(await matchesCurrentMode(site))) return { ok: false, error: OTHER_MODE_ERROR };
  return { ok: true, site };
}

export async function checkDomainAction(
  input: string,
): Promise<Result<{ result: DomainAvailability; suggestions: DomainAvailability[] }>> {
  if (!(await getCurrentUser())) return { ok: false, error: "Non authentifié" };
  if (typeof input !== "string") return { ok: false, error: "Nom de domaine invalide" };
  const fqdn = normalizeFqdn(input);
  if (!isValidFqdn(fqdn))
    return { ok: false, error: "Nom de domaine invalide (exemple : boulangerie-dupont.fr)" };
  try {
    const providers = await getProviders();
    const [result, suggestions] = await Promise.all([
      providers.domain.check(fqdn),
      providers.domain.suggest(fqdn),
    ]);
    return { ok: true, result, suggestions: suggestions.filter((s) => s.fqdn !== fqdn) };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

const step1Schema = z.object({
  clientName: z
    .string()
    .trim()
    .min(2, "Le nom du client doit faire au moins 2 caractères")
    .max(80, "Le nom du client est trop long (80 caractères maximum)"),
  fqdn: z
    .string()
    .transform(normalizeFqdn)
    .refine(isValidFqdn, "Nom de domaine invalide (exemple : boulangerie-dupont.fr)"),
  owned: z.boolean(),
  formsEmail: z
    .string()
    .trim()
    .email("Adresse email de réception des formulaires invalide")
    .or(z.literal("")),
  price: z.number().nullable(),
  currency: z.string().nullable(),
  confirmPurchase: z.boolean(),
  confirmServerOrder: z.boolean(),
});

export type Step1Payload = z.input<typeof step1Schema>;

/** Order states in which the domain can no longer be changed: money may already be engaged. */
const ORDER_ENGAGED = ["ordering", "pending", "registered"] as const;

export async function submitStep1Action(
  siteId: string,
  payload: Step1Payload,
): Promise<Result<{ deploymentId: string }>> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Non authentifié" };
  const parsed = step1Schema.safeParse(payload);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Formulaire invalide" };
  const d = parsed.data;
  const found = await siteForAction(siteId);
  if (!found.ok) return { ok: false, error: found.error };
  const site = found.site;

  // Step 1 is for new sites, or for a provision that failed before anything went live.
  if (site.liveReleaseId || (site.status !== "draft" && site.status !== "error"))
    return { ok: false, error: "L'infrastructure de ce site est déjà en place." };

  const settings = await getSettings();
  if (isReservedDomain(d.fqdn, settings))
    return {
      ok: false,
      error: "Ce domaine est réservé à l'outil et aux préproductions : choisissez celui du client.",
    };
  const taken = await prisma.domain.findFirst({
    where: { fqdn: d.fqdn, siteId: { not: siteId }, site: { status: { not: "draft" } } },
    select: { site: { select: { clientName: true } } },
  });
  if (taken)
    return {
      ok: false,
      error: `Ce domaine est déjà utilisé par le site ${taken.site.clientName}.`,
    };
  const current = await prisma.domain.findUnique({ where: { siteId } });
  if (
    current &&
    current.fqdn !== d.fqdn &&
    (current.orderId || (ORDER_ENGAGED as readonly string[]).includes(current.orderStatus))
  )
    return {
      ok: false,
      error: `Le domaine ${current.fqdn} a déjà été commandé : il ne peut plus être changé pour ce site.`,
    };

  const needsPurchase =
    !d.owned && !(current?.fqdn === d.fqdn && current.orderStatus === "registered");
  let price = d.price;
  let currency = d.currency;
  if (needsPurchase) {
    if (!d.confirmPurchase)
      return { ok: false, error: "Confirmez l'achat du domaine pour continuer." };
    if (user.role !== "admin")
      return { ok: false, error: "L'achat d'un domaine doit être confirmé par un administrateur." };
    // The price shown in the browser is only indicative: check it again here.
    try {
      const check = await (await getProviders()).domain.check(d.fqdn);
      if (!check.available)
        return { ok: false, error: check.reason ?? `${d.fqdn} n'est plus disponible.` };
      if (check.price !== undefined && d.price !== null && check.price > d.price + 0.01)
        return {
          ok: false,
          error: `Le prix de ${d.fqdn} est passé à ${check.price.toFixed(2)} € : vérifiez à nouveau le domaine.`,
        };
      price = check.price ?? d.price;
      currency = check.currency ?? d.currency;
    } catch (err) {
      if (!(err instanceof ProviderNotConfiguredError))
        return { ok: false, error: errorMessage(err) };
    }
  }

  const placement = await placementForSite(siteId);
  const ordersServer = placement.kind === "new-server";
  if (placement.kind === "new-server") {
    if (!d.confirmServerOrder)
      return {
        ok: false,
        error: "Aucun serveur disponible : confirmez la commande d'un nouveau serveur.",
      };
    if (user.role !== "admin")
      return {
        ok: false,
        error: "La commande d'un serveur doit être confirmée par un administrateur.",
      };
    if (placement.offerPrice === null)
      return {
        ok: false,
        error: `Commande de serveur impossible : ${placement.offerError ?? "prix indisponible"}. Vérifiez l'intégration Scaleway, ou ajoutez un serveur existant (Paramètres > Serveurs).`,
      };
  }

  await saveStep1(siteId, {
    clientName: d.clientName,
    fqdn: d.fqdn,
    owned: d.owned,
    formsEmail: d.formsEmail,
    price,
    currency,
  });
  if (needsPurchase)
    await audit(user, "domain.purchase.confirm", {
      target: d.fqdn,
      amount: price ?? undefined,
      currency: currency ?? "EUR",
      details: { siteId },
    });
  if (placement.kind === "new-server")
    await audit(user, "server.order", {
      target: placement.offerId,
      amount: placement.offerPrice ?? undefined,
      currency: "EUR",
      details: { siteId, source: "wizard" },
    });

  try {
    const deployment = await startProvision(siteId, user.id, {
      serverOrderConfirmedById: ordersServer ? user.id : null,
      serverOrderMaxPrice: placement.kind === "new-server" ? placement.offerPrice : null,
      domainPurchaseConfirmedById: needsPurchase ? user.id : null,
    });
    revalidatePath("/");
    return { ok: true, deploymentId: deployment.id };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/**
 * Resumes a failed deployment at the step that failed, with the confirmations
 * given when it was started: a retry never buys or orders anything that an
 * admin did not confirm.
 */
export async function retryDeploymentAction(deploymentId: string): Promise<Result> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Non authentifié" };
  const deployment = await prisma.deployment.findUnique({ where: { id: String(deploymentId) } });
  if (!deployment) return { ok: false, error: "Déploiement introuvable" };
  const found = await siteForAction(deployment.siteId);
  if (!found.ok) return { ok: false, error: found.error };
  try {
    await retryDeployment(deployment.id);
    revalidatePath(`/sites/${deployment.siteId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/**
 * Admin only: confirms the order of a new server for a provision that stopped
 * because no server had room, then resumes it.
 */
export async function confirmServerOrderAction(
  deploymentId: string,
): Promise<Result<{ price: number }>> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Non authentifié" };
  if (user.role !== "admin")
    return {
      ok: false,
      error: "La commande d'un serveur doit être confirmée par un administrateur.",
    };
  const deployment = await prisma.deployment.findUnique({ where: { id: String(deploymentId) } });
  if (!deployment || deployment.kind !== "provision")
    return { ok: false, error: "Déploiement introuvable" };
  const found = await siteForAction(deployment.siteId);
  if (!found.ok) return { ok: false, error: found.error };
  const placement = await placementForSite(deployment.siteId);
  if (placement.kind === "existing") {
    await retryDeployment(deployment.id);
    return { ok: true, price: 0 };
  }
  if (placement.offerPrice === null)
    return {
      ok: false,
      error: `Commande de serveur impossible : ${placement.offerError ?? "prix indisponible"}.`,
    };
  try {
    await retryDeployment(deployment.id, {
      serverOrderConfirmedById: user.id,
      serverOrderMaxPrice: placement.offerPrice,
    });
    await audit(user, "server.order", {
      target: placement.offerId,
      amount: placement.offerPrice,
      currency: "EUR",
      details: { siteId: deployment.siteId, deploymentId: deployment.id, source: "retry" },
    });
    revalidatePath(`/deploy/${deployment.siteId}/step-2`);
    return { ok: true, price: placement.offerPrice };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function startStagingAction(
  siteId: string,
  releaseId: string,
): Promise<Result<{ deploymentId: string }>> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Non authentifié" };
  const found = await siteForAction(siteId);
  if (!found.ok) return { ok: false, error: found.error };
  const site = found.site;
  const release = await prisma.release.findFirst({ where: { id: String(releaseId), siteId } });
  if (!release) return { ok: false, error: "Version introuvable" };
  const analysis = release.analysis as Analysis | null;
  if (!analysis?.ok)
    return {
      ok: false,
      error: "Cette version n'a pas passé la vérification automatique (étape 3).",
    };
  if (!site.serverId || site.status === "draft" || site.status === "provisioning")
    return { ok: false, error: "L'infrastructure n'est pas encore prête (étape 2)." };
  try {
    const deployment = await startStagingDeploy(siteId, release.id, user.id);
    revalidatePath(`/sites/${siteId}`);
    return { ok: true, deploymentId: deployment.id };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function startPromoteAction(
  siteId: string,
  releaseId: string,
): Promise<Result<{ deploymentId: string }>> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Non authentifié" };
  const found = await siteForAction(siteId);
  if (!found.ok) return { ok: false, error: found.error };
  const site = found.site;
  if (!site.domain || !site.serverId)
    return { ok: false, error: "L'infrastructure du site n'est pas prête." };
  if (site.stagingReleaseId !== releaseId)
    return { ok: false, error: "Déployez d'abord cette version en préproduction." };
  try {
    const deployment = await startPromote(siteId, releaseId, user.id);
    await audit(user, "site.publish", { target: site.domain ?? site.slug, details: { releaseId } });
    revalidatePath("/");
    revalidatePath(`/sites/${siteId}`);
    return { ok: true, deploymentId: deployment.id };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function startRollbackAction(
  siteId: string,
  releaseId: string,
): Promise<Result<{ deploymentId: string }>> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Non authentifié" };
  const found = await siteForAction(siteId);
  if (!found.ok) return { ok: false, error: found.error };
  const site = found.site;
  if (!site.liveReleaseId) return { ok: false, error: "Le site n'est pas en production." };
  if (site.liveReleaseId === releaseId)
    return { ok: false, error: "Cette version est déjà en ligne." };
  // Only a version of this site that was already published can go back online.
  const release = await prisma.release.findFirst({
    where: { id: String(releaseId), siteId, gitTag: { not: null } },
  });
  if (!release)
    return {
      ok: false,
      error: "Seule une version déjà publiée de ce site peut être remise en ligne.",
    };
  const last = await prisma.deployment.findFirst({
    where: { siteId, environment: "production", status: "succeeded" },
    orderBy: { createdAt: "desc" },
  });
  try {
    const deployment = await startRollback(siteId, release.id, user.id, last?.id ?? null);
    await audit(user, "site.rollback", {
      target: site.domain ?? site.slug,
      details: { releaseId: release.id, version: release.version },
    });
    revalidatePath(`/sites/${siteId}`);
    return { ok: true, deploymentId: deployment.id };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** Rewrites the forms of a release so they post to the built-in endpoint, then re-analyses it. */
export async function fixFormsAction(
  releaseId: string,
): Promise<Result<{ fixed: number; analysis: Analysis }>> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Non authentifié" };
  const release = await prisma.release.findUnique({
    where: { id: String(releaseId) },
    include: {
      site: { select: { id: true, isDemo: true } },
      _count: { select: { deployments: true } },
    },
  });
  if (!release) return { ok: false, error: "Version introuvable" };
  if (!(await matchesCurrentMode(release.site))) return { ok: false, error: OTHER_MODE_ERROR };
  // A version already sent to GitHub or to a server is frozen: GitHub, the
  // servers and the pilot must keep the same files.
  if (release.commitSha || release._count.deployments > 0)
    return {
      ok: false,
      error: "Cette version a déjà été déployée : déposez une nouvelle archive.",
    };
  try {
    const dir = releaseDir(release.id);
    const files = await listSiteFiles(dir);
    const { fixed } = await fixForms(dir, files);
    const analysis = await analyzeSite(dir, files);
    await prisma.release.update({
      where: { id: release.id },
      data: { analysis: analysis as object, fileCount: files.length },
    });
    revalidatePath(`/deploy/${release.site.id}/step-3`);
    return { ok: true, fixed, analysis };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** Queues again the email of a submission that was not transmitted. */
export async function resendSubmissionAction(submissionId: string): Promise<Result> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Non authentifié" };
  const submission = await prisma.formSubmission.findUnique({
    where: { id: submissionId },
    select: {
      id: true,
      siteId: true,
      emailedAt: true,
      site: { select: { formsEmail: true, isDemo: true } },
    },
  });
  if (!submission) return { ok: false, error: "Message introuvable" };
  if (!(await matchesCurrentMode(submission.site))) return { ok: false, error: OTHER_MODE_ERROR };
  if (submission.emailedAt) return { ok: false, error: "Ce message a déjà été transmis." };
  if (!submission.site.formsEmail)
    return { ok: false, error: "Aucune adresse de réception configurée pour ce site." };
  try {
    await queueSubmissionMail(submission.id);
    revalidatePath(`/sites/${submission.siteId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** Clears a failed or missing Claude report and queues a new one. */
export async function retryAiReportAction(releaseId: string): Promise<Result> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Non authentifié" };
  const release = await prisma.release.findUnique({
    where: { id: releaseId },
    select: { id: true, aiReport: true },
  });
  if (!release) return { ok: false, error: "Version introuvable" };
  const current = release.aiReport as AiReport | null;
  if (current && !aiReportRetryable(current.generatedBy))
    return { ok: false, error: "Le rapport existe déjà." };
  try {
    await prisma.release.update({ where: { id: releaseId }, data: { aiReport: Prisma.DbNull } });
    await enqueue(
      QUEUES.aiReport,
      { releaseId },
      { singletonKey: `ai:${releaseId}:${Date.now()}` },
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function getAiReportAction(releaseId: string): Promise<AiReport | null> {
  if (!(await getCurrentUser())) return null;
  const release = await prisma.release.findUnique({
    where: { id: releaseId },
    select: { aiReport: true },
  });
  return (release?.aiReport as AiReport | null) ?? null;
}

/**
 * Deletes a site that never got any infrastructure: a draft, or a site whose
 * first provision failed before a server was attached.
 */
export async function deleteDraftAction(siteId: string): Promise<Result> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Non authentifié" };
  const found = await siteForAction(siteId);
  if (!found.ok) return { ok: false, error: found.error };
  const site = found.site;
  const domain = await prisma.domain.findUnique({ where: { siteId } });
  const deletable =
    !site.serverId &&
    !site.liveReleaseId &&
    !site.stagingReleaseId &&
    (site.status === "draft" || site.status === "error") &&
    (!domain || domain.orderStatus === "none" || domain.orderStatus === "failed");
  if (!deletable)
    return {
      ok: false,
      error: "Ce site a déjà un serveur ou un domaine commandé : il ne peut pas être supprimé ici.",
    };
  const releases = await prisma.release.findMany({ where: { siteId }, select: { id: true } });
  await prisma.site.delete({ where: { id: siteId } });
  await Promise.all(
    releases.map((r) =>
      rm(releaseDir(r.id), { recursive: true, force: true }).catch(() => undefined),
    ),
  );
  await audit(user, "site.deleteDraft", { target: site.clientName, details: { siteId } });
  revalidatePath("/");
  return { ok: true };
}
