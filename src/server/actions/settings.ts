"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "../db";
import { env } from "../env";
import { encryptJson } from "../crypto";
import { getCurrentUser } from "../session";
import { audit } from "../audit";
import { getSettings, setSetting, type Settings } from "../settings";
import { INTEGRATIONS, type IntegrationName } from "../providers";
import { resetDemo, seedDemo } from "../demo/seed";
import { enqueue, QUEUES } from "../jobs/boss";
import { collectAllMetrics } from "../jobs/maintenance";
import { createUserWithPassword } from "../users";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

async function admin(): Promise<{ id: string; email: string } | null> {
  const user = await getCurrentUser();
  return user?.role === "admin" ? user : null;
}

export async function toggleDemoAction(on: boolean): Promise<{ error?: string }> {
  if (!(await admin())) return { error: "Réservé aux administrateurs" };
  if (env().DEMO_MODE && !on)
    return { error: "Le mode démo est forcé par la configuration (DEMO_MODE=true)" };
  await setSetting("demoMode", on);
  if (on) await seedDemo();
  revalidatePath("/", "layout");
  return {};
}

export async function resetDemoAction(): Promise<Result> {
  const user = await admin();
  if (!user) return { ok: false, error: "Réservé aux administrateurs" };
  await resetDemo();
  await audit(user, "demo.reset");
  revalidatePath("/", "layout");
  return { ok: true };
}

const integrationSchema = z.record(z.string(), z.string());

export async function saveIntegrationAction(
  provider: IntegrationName,
  fields: Record<string, string>,
): Promise<Result> {
  const user = await admin();
  if (!user) return { ok: false, error: "Réservé aux administrateurs" };
  if (!INTEGRATIONS.includes(provider)) return { ok: false, error: "Intégration inconnue" };
  const parsed = integrationSchema.safeParse(fields);
  if (!parsed.success) return { ok: false, error: "Champs invalides" };
  const clean = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v.trim() !== ""));
  if (Object.keys(clean).length === 0) {
    await prisma.integration.deleteMany({ where: { provider } });
  } else {
    const encrypted = encryptJson(clean, env().APP_ENCRYPTION_KEY);
    await prisma.integration.upsert({
      where: { provider },
      create: { provider, encrypted },
      update: { encrypted, lastTestAt: null, lastTestOk: null },
    });
  }
  await audit(user, "integration.save", { target: provider });
  revalidatePath("/settings/integrations");
  return { ok: true };
}

export async function testIntegrationAction(
  provider: IntegrationName,
): Promise<Result<{ message: string }>> {
  const user = await admin();
  if (!user) return { ok: false, error: "Réservé aux administrateurs" };
  const settings = await getSettings();
  const row = await prisma.integration.findUnique({ where: { provider } });
  if (!row) return { ok: false, error: "Aucune clé enregistrée" };
  // Real connectivity tests arrive with each real provider (phases 2 to 7).
  const message = settings.demoMode
    ? "Mode démo : test simulé, clé enregistrée."
    : "Clé enregistrée. Le test réel de connexion arrive avec l'intégration correspondante.";
  await prisma.integration.update({
    where: { provider },
    data: { lastTestAt: new Date(), lastTestOk: settings.demoMode },
  });
  revalidatePath("/settings/integrations");
  return { ok: true, message };
}

const agencySchema = z.object({
  agencyName: z.string().min(1).max(80),
  techDomain: z
    .string()
    .min(3)
    .max(120)
    .regex(/^[a-z0-9.-]+$/),
  previewSubdomain: z
    .string()
    .min(1)
    .max(30)
    .regex(/^[a-z0-9-]+$/),
  defaultOffer: z.string().min(1).max(30),
  defaultZone: z.string().min(1).max(30),
  gandiOrganizationId: z.string().max(120),
  gandiEmail: z.string().max(120),
  diskUsedPctMax: z.coerce.number().min(50).max(99),
  ramUsedPctMax: z.coerce.number().min(50).max(99),
  loadPerVcpuMax: z.coerce.number().min(0.2).max(4),
  sitesHardCap: z.coerce.number().int().min(1).max(1000),
  warnPct: z.coerce.number().min(30).max(99),
});

export async function saveAgencyAction(input: Record<string, string>): Promise<Result> {
  const user = await admin();
  if (!user) return { ok: false, error: "Réservé aux administrateurs" };
  const parsed = agencySchema.safeParse(input);
  if (!parsed.success)
    return {
      ok: false,
      error: parsed.error.issues.map((i) => `${i.path.join(".")} : ${i.message}`).join(", "),
    };
  const d = parsed.data;
  const current = await getSettings();
  await setSetting("agencyName", d.agencyName);
  await setSetting("techDomain", d.techDomain);
  await setSetting("previewSubdomain", d.previewSubdomain);
  await setSetting("defaultOffer", d.defaultOffer);
  await setSetting("defaultZone", d.defaultZone);
  await setSetting("gandiContact", { organizationId: d.gandiOrganizationId, email: d.gandiEmail });
  const capacity: Settings["capacity"] = {
    ...current.capacity,
    diskUsedPctMax: d.diskUsedPctMax,
    ramUsedPctMax: d.ramUsedPctMax,
    loadPerVcpuMax: d.loadPerVcpuMax,
    sitesHardCap: d.sitesHardCap,
    warnPct: d.warnPct,
  };
  await setSetting("capacity", capacity);
  await audit(user, "settings.save");
  revalidatePath("/settings/agency");
  return { ok: true };
}

export async function orderServerAction(
  offerId: string,
  monthlyPrice: number | null,
): Promise<Result> {
  const user = await admin();
  if (!user) return { ok: false, error: "Seul un administrateur peut commander un serveur" };
  await audit(user, "server.order", {
    target: offerId,
    amount: monthlyPrice ?? undefined,
    currency: "EUR",
    details: { source: "settings" },
  });
  await enqueue(QUEUES.serverOrder, { offerId });
  revalidatePath("/settings/servers");
  return { ok: true };
}

export async function refreshMetricsAction(): Promise<Result<{ count: number }>> {
  if (!(await getCurrentUser())) return { ok: false, error: "Non authentifié" };
  const count = await collectAllMetrics();
  revalidatePath("/settings/servers");
  revalidatePath("/");
  return { ok: true, count };
}

export async function retireServerAction(serverId: string): Promise<Result> {
  const user = await admin();
  if (!user) return { ok: false, error: "Réservé aux administrateurs" };
  const sites = await prisma.site.count({
    where: { serverId, status: { notIn: ["draft", "error"] } },
  });
  if (sites > 0) return { ok: false, error: "Ce serveur héberge encore des sites" };
  await prisma.server.update({ where: { id: serverId }, data: { status: "retired" } });
  await audit(user, "server.retire", { target: serverId });
  revalidatePath("/settings/servers");
  return { ok: true };
}

const userSchema = z.object({
  name: z.string().min(1).max(80),
  email: z.string().email(),
  password: z.string().min(8).max(128),
  role: z.enum(["admin", "manager"]),
});

export async function createUserAction(input: Record<string, string>): Promise<Result> {
  const user = await admin();
  if (!user) return { ok: false, error: "Réservé aux administrateurs" };
  const parsed = userSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: "Vérifiez les champs (mot de passe : 8 caractères minimum)" };
  const exists = await prisma.user.findUnique({
    where: { email: parsed.data.email.toLowerCase() },
  });
  if (exists) return { ok: false, error: "Un compte existe déjà avec cet email" };
  await createUserWithPassword(parsed.data);
  await audit(user, "user.create", { target: parsed.data.email });
  revalidatePath("/settings/users");
  return { ok: true };
}

export async function setUserRoleAction(
  userId: string,
  role: "admin" | "manager",
): Promise<Result> {
  const user = await admin();
  if (!user) return { ok: false, error: "Réservé aux administrateurs" };
  if (userId === user.id)
    return { ok: false, error: "Vous ne pouvez pas modifier votre propre rôle" };
  await prisma.user.update({ where: { id: userId }, data: { role } });
  await audit(user, "user.setRole", { target: userId, details: { role } });
  revalidatePath("/settings/users");
  return { ok: true };
}

export async function deleteUserAction(userId: string): Promise<Result> {
  const user = await admin();
  if (!user) return { ok: false, error: "Réservé aux administrateurs" };
  if (userId === user.id)
    return { ok: false, error: "Vous ne pouvez pas supprimer votre propre compte" };
  await prisma.user.delete({ where: { id: userId } });
  await audit(user, "user.delete", { target: userId });
  revalidatePath("/settings/users");
  return { ok: true };
}
