"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "../db";
import { getCurrentUser } from "../session";
import { audit } from "../audit";
import { getProviders, ProviderNotConfiguredError, type DomainAvailability } from "../providers";
import { createDraftSite, placementForSite, saveStep1 } from "../sites";
import { isValidFqdn, normalizeFqdn } from "@/lib/slug";
import {
  retryDeployment,
  startProvision,
  startPromote,
  startRollback,
  startStagingDeploy,
} from "../jobs/pipelines";
import type { AiReport } from "../providers/types";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

function errorMessage(err: unknown): string {
  if (err instanceof ProviderNotConfiguredError) return err.message;
  return err instanceof Error ? err.message : "Erreur inattendue";
}

export async function createSiteAction(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const clientName = String(formData.get("clientName") ?? "").trim();
  if (clientName.length < 2) redirect("/deploy/new?error=nom");
  const site = await createDraftSite(user.id, clientName);
  redirect(`/deploy/${site.id}/step-1`);
}

export async function checkDomainAction(
  input: string,
): Promise<Result<{ result: DomainAvailability; suggestions: DomainAvailability[] }>> {
  if (!(await getCurrentUser())) return { ok: false, error: "Non authentifié" };
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
  clientName: z.string().min(2).max(80),
  fqdn: z.string().transform(normalizeFqdn).refine(isValidFqdn, "Nom de domaine invalide"),
  owned: z.boolean(),
  formsEmail: z.string().email().or(z.literal("")),
  price: z.number().nullable(),
  currency: z.string().nullable(),
  confirmPurchase: z.boolean(),
  confirmServerOrder: z.boolean(),
});

export type Step1Payload = z.input<typeof step1Schema>;

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
  const site = await prisma.site.findUnique({ where: { id: siteId } });
  if (!site) return { ok: false, error: "Site introuvable" };

  const needsPurchase = !d.owned;
  if (needsPurchase && !d.confirmPurchase)
    return { ok: false, error: "Confirmez l'achat du domaine pour continuer." };
  if (needsPurchase && user.role !== "admin")
    return { ok: false, error: "L'achat d'un domaine doit être confirmé par un administrateur." };

  const placement = await placementForSite(siteId);
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
  }

  await saveStep1(siteId, {
    clientName: d.clientName,
    fqdn: d.fqdn,
    owned: d.owned,
    formsEmail: d.formsEmail,
    price: d.price,
    currency: d.currency,
  });
  if (needsPurchase)
    await audit(user, "domain.purchase.confirm", {
      target: d.fqdn,
      amount: d.price ?? undefined,
      currency: d.currency ?? "EUR",
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
      confirmServerOrder: d.confirmServerOrder && user.role === "admin",
    });
    revalidatePath("/");
    return { ok: true, deploymentId: deployment.id };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function retryDeploymentAction(deploymentId: string): Promise<Result> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Non authentifié" };
  try {
    await retryDeployment(deploymentId);
    return { ok: true };
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
  const release = await prisma.release.findFirst({ where: { id: releaseId, siteId } });
  if (!release) return { ok: false, error: "Version introuvable" };
  const site = await prisma.site.findUniqueOrThrow({ where: { id: siteId } });
  if (!site.serverId || site.status === "draft" || site.status === "provisioning")
    return { ok: false, error: "L'infrastructure n'est pas encore prête (étape 2)." };
  try {
    const deployment = await startStagingDeploy(siteId, releaseId, user.id);
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
  const site = await prisma.site.findUniqueOrThrow({ where: { id: siteId } });
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
  const site = await prisma.site.findUniqueOrThrow({ where: { id: siteId } });
  if (site.status !== "live" || !site.liveReleaseId)
    return { ok: false, error: "Le site n'est pas en production." };
  if (site.liveReleaseId === releaseId)
    return { ok: false, error: "Cette version est déjà en ligne." };
  const last = await prisma.deployment.findFirst({
    where: { siteId, environment: "production", status: "succeeded" },
    orderBy: { createdAt: "desc" },
  });
  try {
    const deployment = await startRollback(siteId, releaseId, user.id, last?.id ?? "");
    await audit(user, "site.rollback", {
      target: site.domain ?? site.slug,
      details: { releaseId },
    });
    revalidatePath(`/sites/${siteId}`);
    return { ok: true, deploymentId: deployment.id };
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

export async function deleteDraftAction(siteId: string): Promise<void> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const site = await prisma.site.findUnique({ where: { id: siteId } });
  if (site && (site.status === "draft" || site.status === "error")) {
    await prisma.site.delete({ where: { id: siteId } });
  }
  revalidatePath("/");
  redirect("/");
}
