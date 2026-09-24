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

/** Host of the pilot, as the site servers reach it to relay contact forms. */
export function pilotHost(): string {
  return new URL(env().APP_URL).host;
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
    pilotHost: pilotHost(),
    previewToken: site.previewToken,
    log: (m) => log.info(m),
  });
}

/**
 * Deletes old releases on the server once a deployment succeeded. Keeps what a
 * rollback may need; never fails the deployment.
 */
export async function pruneOldReleases(input: {
  site: Site;
  server: Server;
  environment: "staging" | "production";
  keepReleaseIds: string[];
  providers: Providers;
  log: Logger;
}): Promise<void> {
  const { site, server, environment, keepReleaseIds, providers, log } = input;
  try {
    await runtimeFor(site.runtime).prune(providers.agent, {
      server: serverRef(server),
      slug: site.slug,
      environment,
      keepReleaseIds: [...new Set(keepReleaseIds.filter(Boolean))],
      log: (m) => log.info(m),
    });
  } catch (err) {
    await log.warn(
      `Nettoyage des anciennes versions impossible : ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Releases kept in production for rollbacks: the last ones that were published. */
export async function productionKeepList(siteId: string, count = 3): Promise<string[]> {
  const published = await prisma.release.findMany({
    where: { siteId, gitTag: { not: null } },
    orderBy: { version: "desc" },
    take: count,
    select: { id: true },
  });
  return published.map((r) => r.id);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Checks HTTPS on a host. Right after a Caddy reload the certificate is often
 * still being issued, so a failure is retried a few times before being logged
 * as a warning (the daily check follows up).
 */
export async function checkTls(
  host: string,
  siteId: string,
  providers: Providers,
  log: Logger,
  attempts = 4,
): Promise<void> {
  let result = await providers.agent.checkTls(host);
  for (let i = 1; i < attempts && !result.ok; i++) {
    await sleep(providers.demo ? 100 : 15_000);
    result = await providers.agent.checkTls(host);
  }
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

/**
 * Captures the site. Real captures load the public URL (production domain, or
 * the preview host through its secret link); the demo mock ignores the URL.
 * A missing thumbnail never fails a deployment.
 */
export async function captureScreenshot(
  site: Site,
  environment: "staging" | "production",
  providers: Providers,
  settings: Settings,
  log: Logger,
): Promise<void> {
  const base = path.join(screenshotsDir(), site.id);
  const url =
    environment === "production" && site.domain
      ? `https://${site.domain}/`
      : `https://${site.previewHost ?? previewHostFor(site.slug, settings)}/__preview/${site.previewToken}`;
  try {
    const ext = await providers.screenshot.capture(url, `${base}.svg`, site.clientName);
    await prisma.site.update({
      where: { id: site.id },
      data: { screenshotPath: `${site.id}.${ext}` },
    });
    await log.info("Capture d'écran mise à jour");
  } catch (err) {
    await log.warn(
      `Capture d'écran impossible : ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
