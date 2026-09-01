import type { Release, Server, Site } from "@prisma/client";
import path from "node:path";
import { prisma } from "../../db";
import type { Providers } from "../../providers";
import { previewHostFor, type Settings } from "../../settings";
import { releaseDir, screenshotsDir } from "../../releases/paths";
import { runtimeFor } from "../../deploy/runtime";
import { serverRef } from "./server";
import type { Logger } from "../log";
import { env } from "../../env";

export function pilotHost(settings: Settings): string {
  return `deploy.${settings.techDomain}`;
}

export function productionHosts(site: Site): string[] {
  if (!site.domain) throw new Error("Le site n'a pas de domaine");
  return [site.domain, `www.${site.domain}`];
}

export async function deployRelease(input: {
  site: Site;
  server: Server;
  release: Release;
  environment: "staging" | "production";
  providers: Providers;
  settings: Settings;
  log: Logger;
}): Promise<void> {
  const { site, server, release, environment, providers, settings, log } = input;
  const hosts =
    environment === "production" ? productionHosts(site) : [previewHostFor(site.slug, settings)];
  const runtime = runtimeFor(site.runtime);
  await runtime.deploy(providers.agent, {
    server: serverRef(server),
    slug: site.slug,
    releaseId: release.id,
    releaseDir: releaseDir(release.id),
    environment,
    hosts,
    pilotHost: pilotHost(settings),
    previewToken: site.previewToken,
    log: (m) => log.info(m),
  });
}

export async function checkTls(
  host: string,
  siteId: string,
  providers: Providers,
  log: Logger,
): Promise<void> {
  const result = await providers.agent.checkTls(host);
  await prisma.sslCheck.create({
    data: {
      siteId,
      host,
      ok: result.ok,
      issuer: result.issuer,
      expiresAt: result.expiresAt,
      error: result.error,
    },
  });
  if (result.ok)
    await log.success(`HTTPS actif sur ${host} (${result.issuer ?? "certificat valide"})`);
  else await log.warn(`HTTPS pas encore disponible sur ${host} : ${result.error ?? "inconnu"}`);
}

export async function captureScreenshot(
  site: Site,
  url: string,
  providers: Providers,
  log: Logger,
): Promise<void> {
  const base = path.join(screenshotsDir(), site.id);
  const ext = await providers.screenshot.capture(url, `${base}.svg`, site.clientName);
  await prisma.site.update({
    where: { id: site.id },
    data: { screenshotPath: `${site.id}.${ext}` },
  });
  await log.info("Capture d'écran mise à jour");
}

export function localPreviewUrl(releaseId: string): string {
  return `${env().APP_URL}/api/preview/${releaseId}/`;
}
