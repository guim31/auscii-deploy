"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "../db";
import { env } from "../env";
import { encryptJson } from "../crypto";
import { getCurrentUser } from "../session";
import { audit } from "../audit";
import { getSettings, isDemoMode, setSetting, type Settings } from "../settings";
import { INTEGRATIONS, type DnsRecord, type IntegrationName } from "../providers";
import type { SendingDomainStatus } from "../providers/mail/resend";
import { resetDemo, seedDemo } from "../demo/seed";
import { collectAllMetrics } from "../jobs/maintenance";
import { createUserWithPassword } from "../users";
import { PASSWORD_MIN_LENGTH } from "../auth";
import { mergeIntegrationFields } from "../integrations";
import { matchesCurrentMode, OTHER_MODE_ERROR } from "../mode";
import { isValidFqdn } from "@/lib/slug";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

async function admin(): Promise<{ id: string; email: string } | null> {
  const user = await getCurrentUser();
  return user?.role === "admin" ? user : null;
}

export async function toggleDemoAction(on: boolean): Promise<{ error?: string }> {
  if (!(await admin())) return { error: "Réservé aux administrateurs" };
  if (typeof on !== "boolean") return { error: "Valeur invalide" };
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

const integrationSchema = z.record(z.string().max(40), z.string().max(20_000));

export async function saveIntegrationAction(
  provider: IntegrationName,
  fields: Record<string, string>,
): Promise<Result> {
  const user = await admin();
  if (!user) return { ok: false, error: "Réservé aux administrateurs" };
  if (!INTEGRATIONS.includes(provider) || provider === "ssh")
    return { ok: false, error: "Intégration inconnue" };
  const parsed = integrationSchema.safeParse(fields);
  if (!parsed.success) return { ok: false, error: "Champs invalides" };
  const { loadCredentials } = await import("../providers");
  const saved = (await loadCredentials(provider)) as Record<string, string> | null;
  const merged = mergeIntegrationFields(provider, saved, parsed.data);
  if (!merged.ok) return merged;
  if (Object.keys(merged.values).length === 0)
    return { ok: false, error: "Renseignez au moins la clé." };
  const encrypted = encryptJson(merged.values, env().APP_ENCRYPTION_KEY);
  await prisma.integration.upsert({
    where: { provider },
    create: { provider, encrypted },
    update: { encrypted, lastTestAt: null, lastTestOk: null },
  });
  await audit(user, "integration.save", {
    target: provider,
    details: { fields: Object.keys(parsed.data).filter((k) => parsed.data[k].trim() !== "") },
  });
  revalidatePath("/settings/integrations");
  return { ok: true };
}

/** Removes the keys of an integration (explicit, never as a side effect of an empty form). */
export async function deleteIntegrationAction(provider: IntegrationName): Promise<Result> {
  const user = await admin();
  if (!user) return { ok: false, error: "Réservé aux administrateurs" };
  if (!INTEGRATIONS.includes(provider) || provider === "ssh")
    return { ok: false, error: "Intégration inconnue" };
  await prisma.integration.deleteMany({ where: { provider } });
  await audit(user, "integration.delete", { target: provider });
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
  // Always a real, read-only call, demo mode or not: a green check must mean the key works.
  let message: string;
  let ok = true;
  try {
    if (provider === "gandi") {
      const { loadCredentials } = await import("../providers");
      const { GandiProvider } = await import("../providers/domain/gandi");
      const creds = await loadCredentials("gandi");
      const me = await new GandiProvider(creds).whoAmI();
      const org = creds?.organizationId
        ? me.organizations.find((o) => o.id === creds.organizationId)
        : undefined;
      const orgs = me.organizations.map((o) => `${o.name ?? o.id} (${o.id})`).join(", ");
      if (creds?.organizationId && !org) {
        ok = false;
        message = `Jeton valide (${me.user}) mais l'organisation ${creds.organizationId} est introuvable. Organisations visibles : ${orgs || "aucune"}.`;
      } else {
        message = `Jeton valide (${me.user}). ${org ? `Organisation : ${org.name ?? org.id}.` : `Organisations visibles : ${orgs || "aucune"}.`}`;
      }
    } else if (provider === "github") {
      const { loadCredentials } = await import("../providers");
      const { GitHubProvider } = await import("../providers/git/github");
      const creds = await loadCredentials("github");
      const me = await new GitHubProvider(creds).whoAmI();
      message = `App « ${me.app} » installée sur ${me.org} : ${me.repos} dépôt(s) accessibles.`;
    } else if (provider === "scaleway") {
      const { loadCredentials } = await import("../providers");
      const { ScalewayProvider } = await import("../providers/cloud/scaleway");
      const creds = await loadCredentials("scaleway");
      const me = await new ScalewayProvider(creds).whoAmI(settings.defaultZone);
      message = `Clé valide : ${me.offers} offre(s) disponibles en ${settings.defaultZone}. ${me.project ? `Projet : ${me.project}.` : (me.warning ?? "")}`;
    } else if (provider === "resend") {
      const { loadCredentials } = await import("../providers");
      const { ResendProvider } = await import("../providers/mail/resend");
      const creds = await loadCredentials("resend");
      const me = await new ResendProvider(creds).whoAmI();
      const tech = me.domains.find((d) => d.name.toLowerCase() === settings.techDomain);
      const list = me.domains.map((d) => `${d.name} (${DOMAIN_STATUS[d.status]})`).join(", ");
      if (!tech) {
        message = `Clé valide. Le domaine technique ${settings.techDomain} n'est pas déclaré chez Resend : utilisez « Configurer le domaine d'envoi ». Domaines : ${list || "aucun"}.`;
      } else if (tech.status !== "verified") {
        message = `Clé valide. Le domaine ${tech.name} est ${DOMAIN_STATUS[tech.status]} chez Resend : les envois échoueront tant qu'il n'est pas vérifié.`;
      } else {
        message = `Clé valide. Domaine d'envoi ${tech.name} vérifié.`;
      }
    } else if (provider === "anthropic") {
      const { loadCredentials } = await import("../providers");
      const { AnthropicProvider } = await import("../providers/ai/anthropic");
      const creds = await loadCredentials("anthropic");
      const me = await new AnthropicProvider(creds).whoAmI();
      message = `Clé valide. Modèle : ${me.displayName} (${me.model})${me.contextWindow ? `, contexte ${Math.round(me.contextWindow / 1000)}k tokens` : ""}.`;
    } else {
      message =
        "Clé enregistrée. Le test réel de connexion arrive avec l'intégration correspondante.";
    }
  } catch (err) {
    ok = false;
    message = err instanceof Error ? err.message : "Test impossible";
  }
  await prisma.integration.update({
    where: { provider },
    data: { lastTestAt: new Date(), lastTestOk: ok },
  });
  revalidatePath("/settings/integrations");
  return ok ? { ok: true, message } : { ok: false, error: message };
}

const DOMAIN_STATUS: Record<SendingDomainStatus, string> = {
  not_started: "non vérifié",
  pending: "en attente de vérification",
  verified: "vérifié",
  failed: "en échec",
  temporary_failure: "en échec temporaire",
};

export type SendingDomainView = {
  name: string;
  status: SendingDomainStatus;
  statusLabel: string;
  records: DnsRecord[];
  /** true when the records were written to LiveDNS, false when they must be created by hand. */
  dnsWritten: boolean;
};

/**
 * Declares the tech domain on Resend and writes the SPF/DKIM records through
 * LiveDNS when Gandi is configured. Idempotent; modifies the DNS zone, hence
 * admin-only with an audit entry.
 */
export async function setupSendingDomainAction(): Promise<Result<{ domain: SendingDomainView }>> {
  const user = await admin();
  if (!user) return { ok: false, error: "Réservé aux administrateurs" };
  const settings = await getSettings();
  if (settings.demoMode) {
    return {
      ok: true,
      domain: {
        name: settings.techDomain,
        status: "verified",
        statusLabel: `${DOMAIN_STATUS.verified} (mode démo)`,
        records: [],
        dnsWritten: true,
      },
    };
  }
  try {
    const { loadCredentials } = await import("../providers");
    const { ResendProvider } = await import("../providers/mail/resend");
    const { GandiProvider } = await import("../providers/domain/gandi");
    const resend = new ResendProvider(await loadCredentials("resend"));
    let domain = await resend.ensureSendingDomain(settings.techDomain);
    const gandi = await loadCredentials("gandi");
    let dnsWritten = false;
    if (gandi?.apiKey && domain.records.length > 0) {
      await new GandiProvider(gandi).setRecords(settings.techDomain, domain.records);
      dnsWritten = true;
    }
    if (domain.status !== "verified") domain = await resend.verifyDomain(domain.id);
    await audit(user, "mail.sending_domain", {
      target: settings.techDomain,
      details: { status: domain.status, dnsWritten, records: domain.records.length },
    });
    revalidatePath("/settings/integrations");
    return {
      ok: true,
      domain: {
        name: domain.name,
        status: domain.status,
        statusLabel: DOMAIN_STATUS[domain.status],
        records: domain.records,
        dnsWritten,
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Configuration impossible" };
  }
}

/** Sends a test email to the connected admin through the configured mail provider. */
export async function sendTestEmailAction(): Promise<Result<{ message: string }>> {
  const user = await admin();
  if (!user) return { ok: false, error: "Réservé aux administrateurs" };
  const settings = await getSettings();
  try {
    const { getProviders } = await import("../providers");
    const { defaultSender } = await import("../providers/mail/resend");
    const providers = await getProviders();
    await providers.mail.send({
      to: user.email,
      from: providers.demo ? undefined : await senderFor(settings),
      subject: `[${settings.agencyName}] Email de test auscii-deploy`,
      text: `Cet email confirme que l'envoi depuis auscii-deploy fonctionne (expéditeur par défaut : ${defaultSender(settings.agencyName, settings.techDomain)}).`,
    });
    return {
      ok: true,
      message: providers.demo
        ? `Mode démo : email simulé vers ${user.email}.`
        : `Email envoyé à ${user.email}.`,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Envoi impossible" };
  }
}

async function senderFor(settings: Settings): Promise<string> {
  const { loadCredentials } = await import("../providers");
  const { defaultSender } = await import("../providers/mail/resend");
  const creds = await loadCredentials("resend");
  return creds?.from?.trim() || defaultSender(settings.agencyName, settings.techDomain);
}

const domainField = (label: string) =>
  z
    .string()
    .trim()
    .toLowerCase()
    .refine((v) => isValidFqdn(v), `${label} : nom de domaine invalide (exemple : auscii.site)`);

const agencySchema = z.object({
  agencyName: z.string().trim().min(1, "Nom de l'agence requis").max(80),
  techDomain: domainField("Domaine technique"),
  previewDomain: domainField("Domaine des préproductions").or(z.literal("")),
  previewSubdomain: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/, "Sous-domaine des préproductions invalide"),
  defaultOffer: z.string().trim().min(1, "Offre par défaut requise").max(30),
  defaultZone: z.string().trim().min(1, "Zone par défaut requise").max(30),
  alertEmail: z.string().trim().email("Adresse des alertes invalide").or(z.literal("")),
  gandiOrganizationId: z.string().max(120),
  gandiEmail: z.string().trim().email("Email du contact Gandi invalide").or(z.literal("")),
  gandiOrgName: z.string().max(120),
  gandiGivenName: z.string().max(80),
  gandiFamilyName: z.string().max(80),
  gandiPhone: z
    .string()
    .trim()
    .transform(normalizePhone)
    .refine(
      (v) => v === "" || /^\+\d{1,3}\.\d{6,14}$/.test(v),
      "Téléphone au format Gandi : indicatif, point, numéro (ex. +33.612345678)",
    ),
  gandiStreet: z.string().max(200),
  gandiZip: z.string().max(20),
  gandiCity: z.string().max(80),
  gandiCountry: z.string().regex(/^[A-Za-z]{2}$/, "Pays sur 2 lettres (FR)"),
  diskUsedPctMax: percent("Disque max", 50, 99),
  ramUsedPctMax: percent("Mémoire max", 50, 99),
  loadPerVcpuMax: z.preprocess(
    emptyToUndefined,
    z.coerce
      .number({ error: "Charge CPU max : nombre requis" })
      .min(0.2, "Charge CPU max : 0,2 minimum")
      .max(4, "Charge CPU max : 4 maximum"),
  ),
  sitesHardCap: z.preprocess(
    emptyToUndefined,
    z.coerce
      .number({ error: "Plafond de sites : nombre requis" })
      .int("Plafond de sites : nombre entier")
      .min(1, "Plafond de sites : 1 minimum")
      .max(1000, "Plafond de sites : 1000 maximum"),
  ),
  warnPct: percent("Seuil d'avertissement", 30, 99),
});

/** "06 12 34 56 78", "+33 6 12…" or "+33612345678" → "+33.612345678", the format Gandi expects. */
function normalizePhone(input: string): string {
  const v = input.replace(/[\s()-]/g, "");
  if (/^0\d{9}$/.test(v)) return `+33.${v.slice(1)}`;
  if (/^\+33\d{9}$/.test(v)) return `+33.${v.slice(3)}`;
  if (/^\+33\.0\d{9}$/.test(v)) return `+33.${v.slice(5)}`;
  return v;
}

function emptyToUndefined(v: unknown) {
  return typeof v === "string" && v.trim() === "" ? undefined : v;
}

function percent(label: string, min: number, max: number) {
  return z.preprocess(
    emptyToUndefined,
    z.coerce
      .number({ error: `${label} : nombre requis` })
      .min(min, `${label} : ${min} % minimum`)
      .max(max, `${label} : ${max} % maximum`),
  );
}

export async function saveAgencyAction(input: Record<string, string>): Promise<Result> {
  const user = await admin();
  if (!user) return { ok: false, error: "Réservé aux administrateurs" };
  if (typeof input !== "object" || input === null)
    return { ok: false, error: "Formulaire invalide" };
  const parsed = agencySchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join(" · ") };
  const d = parsed.data;
  const current = await getSettings();
  const previewChanged =
    d.techDomain !== current.techDomain ||
    d.previewSubdomain !== current.previewSubdomain ||
    (d.previewDomain || "") !== (current.previewDomain || "");
  if (previewChanged) {
    // Existing preproduction links, DNS records and certificates follow the old names.
    const deployed = await prisma.site.count({
      where: { stagingReleaseId: { not: null }, isDemo: false },
    });
    if (deployed > 0 && input.confirmPreviewChange !== "yes")
      return {
        ok: false,
        error: `${deployed} site(s) ont déjà une préproduction : changer ces domaines casse leurs liens. Cochez la confirmation pour continuer, puis redéployez leurs préproductions.`,
      };
  }
  await setSetting("agencyName", d.agencyName);
  await setSetting("alertEmail", d.alertEmail);
  await setSetting("techDomain", d.techDomain);
  await setSetting("previewDomain", d.previewDomain);
  await setSetting("previewSubdomain", d.previewSubdomain);
  await setSetting("defaultOffer", d.defaultOffer);
  await setSetting("defaultZone", d.defaultZone);
  await setSetting("gandiContact", {
    organizationId: d.gandiOrganizationId,
    email: d.gandiEmail,
    orgName: d.gandiOrgName,
    givenName: d.gandiGivenName,
    familyName: d.gandiFamilyName,
    phone: d.gandiPhone,
    street: d.gandiStreet,
    zip: d.gandiZip,
    city: d.gandiCity,
    country: d.gandiCountry.toUpperCase(),
  });
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
  if (typeof offerId !== "string" || typeof monthlyPrice !== "number")
    return { ok: false, error: "Prix de l'offre inconnu : rechargez la page." };
  try {
    const { requestStandaloneOrder } = await import("../jobs/maintenance");
    const server = await requestStandaloneOrder({
      offerId,
      maxMonthlyPrice: monthlyPrice,
      userId: user.id,
    });
    await audit(user, "server.order", {
      target: server.name,
      amount: server.monthlyPrice ?? undefined,
      currency: "EUR",
      details: { source: "settings", offer: offerId },
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Commande impossible" };
  }
  revalidatePath("/settings/servers");
  return { ok: true };
}

let lastManualRefresh = 0;

export async function refreshMetricsAction(): Promise<Result<{ count: number }>> {
  if (!(await getCurrentUser())) return { ok: false, error: "Non authentifié" };
  // Each refresh opens an SSH connection to every server: at most once every 30 s.
  if (Date.now() - lastManualRefresh < 30_000)
    return { ok: false, error: "Relevé déjà demandé il y a quelques secondes." };
  lastManualRefresh = Date.now();
  const count = await collectAllMetrics(await isDemoMode());
  revalidatePath("/settings/servers");
  revalidatePath("/");
  return { ok: true, count };
}

export async function deleteServerAction(serverId: string, confirmName: string): Promise<Result> {
  const user = await admin();
  if (!user) return { ok: false, error: "Réservé aux administrateurs" };
  if (typeof serverId !== "string" || typeof confirmName !== "string")
    return { ok: false, error: "Serveur introuvable" };
  const server = await prisma.server.findUnique({ where: { id: serverId } });
  if (!server) return { ok: false, error: "Serveur introuvable" };
  if (!(await matchesCurrentMode(server))) return { ok: false, error: OTHER_MODE_ERROR };
  if (confirmName.trim() !== server.name)
    return { ok: false, error: "Le nom saisi ne correspond pas" };
  const { requestServerDeletion } = await import("../jobs/steps/delete-server");
  try {
    await requestServerDeletion(serverId);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Suppression impossible" };
  }
  await audit(user, "server.delete", {
    target: server.name,
    amount: server.monthlyPrice ?? undefined,
    currency: "EUR",
    details: { provider: server.provider, providerId: server.providerId, ip: server.ip },
  });
  revalidatePath("/settings/servers");
  revalidatePath("/");
  return { ok: true };
}

const PASSWORD_MIN = PASSWORD_MIN_LENGTH;

const userSchema = z.object({
  name: z.string().trim().min(1, "Nom requis").max(80),
  email: z.string().trim().toLowerCase().email("Email invalide"),
  password: z
    .string()
    .min(PASSWORD_MIN, `Mot de passe : ${PASSWORD_MIN} caractères minimum`)
    .max(128, "Mot de passe trop long"),
  role: z.enum(["admin", "manager"], { error: "Rôle invalide" }),
});

export async function createUserAction(input: Record<string, string>): Promise<Result> {
  const user = await admin();
  if (!user) return { ok: false, error: "Réservé aux administrateurs" };
  const parsed = userSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Vérifiez les champs" };
  const exists = await prisma.user.findUnique({ where: { email: parsed.data.email } });
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
  if (typeof userId !== "string" || (role !== "admin" && role !== "manager"))
    return { ok: false, error: "Rôle invalide" };
  if (userId === user.id)
    return { ok: false, error: "Vous ne pouvez pas modifier votre propre rôle" };
  const target = await prisma.user.findUnique({ where: { id: userId } });
  if (!target) return { ok: false, error: "Compte introuvable" };
  await prisma.user.update({ where: { id: userId }, data: { role } });
  await audit(user, "user.setRole", { target: userId, details: { role } });
  revalidatePath("/settings/users");
  return { ok: true };
}

export async function deleteUserAction(userId: string): Promise<Result> {
  const user = await admin();
  if (!user) return { ok: false, error: "Réservé aux administrateurs" };
  if (typeof userId !== "string") return { ok: false, error: "Compte introuvable" };
  if (userId === user.id)
    return { ok: false, error: "Vous ne pouvez pas supprimer votre propre compte" };
  const target = await prisma.user.findUnique({ where: { id: userId } });
  if (!target) return { ok: false, error: "Compte introuvable" };
  await prisma.user.delete({ where: { id: userId } });
  await audit(user, "user.delete", { target: userId });
  revalidatePath("/settings/users");
  return { ok: true };
}

/** Admin: sets a new password for another account and closes its sessions. */
export async function resetUserPasswordAction(userId: string, password: string): Promise<Result> {
  const user = await admin();
  if (!user) return { ok: false, error: "Réservé aux administrateurs" };
  if (typeof userId !== "string" || typeof password !== "string")
    return { ok: false, error: "Compte introuvable" };
  if (userId === user.id)
    return { ok: false, error: "Changez votre propre mot de passe depuis « Mon compte »." };
  if (password.length < PASSWORD_MIN || password.length > 128)
    return { ok: false, error: `Mot de passe : ${PASSWORD_MIN} caractères minimum` };
  const account = await prisma.account.findFirst({
    where: { userId, providerId: "credential" },
    include: { user: { select: { email: true } } },
  });
  if (!account) return { ok: false, error: "Compte introuvable" };
  const { hashPassword } = await import("better-auth/crypto");
  await prisma.$transaction([
    prisma.account.update({
      where: { id: account.id },
      data: { password: await hashPassword(password) },
    }),
    prisma.session.deleteMany({ where: { userId } }),
  ]);
  await audit(user, "user.resetPassword", { target: account.user.email });
  return { ok: true };
}

// ---------- Servers registered by hand and SSH keys (phase 2) ----------

const existingServerSchema = z.object({
  name: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "Nom : lettres minuscules, chiffres et tirets"),
  ip: z.string().regex(/^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]+$/i, "Adresse IP invalide"),
  sshPort: z.coerce.number().int().min(1).max(65535).default(22),
  sshUser: z.string().min(1).max(32).default("deploy"),
  vcpus: z.coerce.number().int().min(1).max(64).default(2),
  offer: z.string().min(1).max(40).default("manuel"),
});

export async function addExistingServerAction(
  input: Record<string, string>,
): Promise<Result<{ serverId: string }>> {
  const user = await admin();
  if (!user) return { ok: false, error: "Réservé aux administrateurs" };
  const parsed = existingServerSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Champs invalides" };
  const settings = await getSettings();
  if (!settings.demoMode && !settings.sshPublicKey) {
    return { ok: false, error: "Générez d'abord la clé SSH du pilote (Intégrations > SSH)." };
  }
  const exists = await prisma.server.findUnique({ where: { name: parsed.data.name } });
  if (exists) return { ok: false, error: "Un serveur porte déjà ce nom" };
  const { registerExistingServer } = await import("../jobs/steps/register-server");
  const server = await registerExistingServer({ ...parsed.data, zone: settings.defaultZone });
  await audit(user, "server.register", { target: server.name, details: { ip: parsed.data.ip } });
  revalidatePath("/settings/servers");
  return { ok: true, serverId: server.id };
}

export async function retestServerAction(serverId: string, forgetHostKey = false): Promise<Result> {
  const user = await admin();
  if (!user) return { ok: false, error: "Réservé aux administrateurs" };
  const server = await prisma.server.findUnique({ where: { id: String(serverId) } });
  if (!server) return { ok: false, error: "Serveur introuvable" };
  if (!(await matchesCurrentMode(server))) return { ok: false, error: OTHER_MODE_ERROR };
  if (server.status === "retired" || server.status === "retiring" || server.status === "ordering")
    return { ok: false, error: "Ce serveur ne peut pas être revérifié dans son état actuel." };
  const { retestServer } = await import("../jobs/steps/register-server");
  await retestServer(serverId, forgetHostKey);
  await audit(user, "server.retest", { target: server.name, details: { forgetHostKey } });
  revalidatePath("/settings/servers");
  return { ok: true };
}

export async function generateSshKeysAction(): Promise<
  Result<{ publicKey: string; fingerprint: string }>
> {
  const user = await admin();
  if (!user) return { ok: false, error: "Réservé aux administrateurs" };
  const { generateSshKeyPair } = await import("../deploy/ssh-keys");
  const pair = generateSshKeyPair(`auscii-deploy ${new Date().toISOString().slice(0, 10)}`);
  const encrypted = encryptJson(
    { privateKey: pair.privateKey, publicKey: pair.publicKey },
    env().APP_ENCRYPTION_KEY,
  );
  await prisma.integration.upsert({
    where: { provider: "ssh" },
    create: { provider: "ssh", encrypted },
    update: { encrypted, lastTestAt: null, lastTestOk: null },
  });
  await setSetting("sshPublicKey", pair.publicKey);
  await audit(user, "ssh.generateKeys", { details: { fingerprint: pair.fingerprint } });
  revalidatePath("/settings/integrations");
  revalidatePath("/settings/servers");
  return { ok: true, publicKey: pair.publicKey, fingerprint: pair.fingerprint };
}

export async function importSshKeyAction(
  privateKey: string,
): Promise<Result<{ publicKey: string; fingerprint: string }>> {
  const user = await admin();
  if (!user) return { ok: false, error: "Réservé aux administrateurs" };
  if (typeof privateKey !== "string" || privateKey.length > 20_000)
    return { ok: false, error: "Clé illisible" };
  const { inspectPrivateKey } = await import("../deploy/ssh-keys");
  let info: { publicKey: string; fingerprint: string };
  try {
    info = inspectPrivateKey(privateKey.trim() + "\n");
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Clé illisible" };
  }
  const encrypted = encryptJson(
    { privateKey: privateKey.trim() + "\n", publicKey: info.publicKey },
    env().APP_ENCRYPTION_KEY,
  );
  await prisma.integration.upsert({
    where: { provider: "ssh" },
    create: { provider: "ssh", encrypted },
    update: { encrypted, lastTestAt: null, lastTestOk: null },
  });
  await setSetting("sshPublicKey", info.publicKey);
  await audit(user, "ssh.importKey", { details: { fingerprint: info.fingerprint } });
  revalidatePath("/settings/integrations");
  revalidatePath("/settings/servers");
  return { ok: true, ...info };
}
