import type { ServerAgent, ServerRef } from "../providers/types";
import { previewCaddyBlock, productionCaddyBlock } from "./caddy";

export type RuntimeDeployInput = {
  server: ServerRef;
  /** Slug of the site, never suffixed: the runtime derives the preproduction folder. */
  slug: string;
  releaseId: string;
  releaseDir: string;
  environment: "staging" | "production";
  hosts: string[];
  pilotHost: string;
  previewToken: string;
  log: (message: string) => Promise<void>;
};

/**
 * A SiteRuntime knows how to put a release live on a server. v1 ships the
 * static runtime only; a docker runtime will implement the same interface.
 */
export interface SiteRuntime {
  readonly kind: "static" | "docker";
  deploy(agent: ServerAgent, input: RuntimeDeployInput): Promise<void>;
  /**
   * Switches production back to a release still present on the server.
   * Returns false when the release is gone (pruned): the caller then redeploys it.
   */
  rollback(
    agent: ServerAgent,
    input: Pick<RuntimeDeployInput, "server" | "slug" | "releaseId" | "log">,
  ): Promise<boolean>;
  /**
   * Deletes old releases of one environment on the server, keeping `keepReleaseIds`
   * and whatever `current` points to. Returns the number of releases deleted.
   */
  prune(
    agent: ServerAgent,
    input: Pick<RuntimeDeployInput, "server" | "slug" | "environment" | "log"> & {
      keepReleaseIds: string[];
    },
  ): Promise<number>;
}

export function releaseName(releaseId: string): string {
  return `rel-${releaseId}`;
}

/** Folder of an environment under /srv/sites, also the name of its Caddy block. */
export function siteDir(slug: string, environment: "staging" | "production"): string {
  return environment === "production" ? slug : `${slug}--preview`;
}

export const staticRuntime: SiteRuntime = {
  kind: "static",

  /**
   * Idempotent, and never changes what is live before everything is checked:
   * folders, upload (immutable release), Caddy block written and validated,
   * then only the switch of `current` and the reload.
   */
  async deploy(agent, input) {
    const {
      server,
      slug,
      releaseId,
      releaseDir,
      environment,
      hosts,
      pilotHost,
      previewToken,
      log,
    } = input;
    const name = releaseName(releaseId);
    const dir = siteDir(slug, environment);
    await log(`Préparation des dossiers /srv/sites/${dir} sur ${server.name}`);
    await agent.ensureSiteDirs(server, dir);
    if (await agent.hasRelease(server, dir, name)) {
      await log(`Release ${name} déjà présente sur ${server.name}, rien à envoyer`);
    } else {
      await log(`Envoi de la release ${name}`);
      await agent.uploadRelease(server, dir, releaseDir, name);
    }
    const block =
      environment === "production"
        ? productionCaddyBlock({ siteSlug: slug, dir, hosts, pilotHost })
        : previewCaddyBlock({ siteSlug: slug, dir, hosts, pilotHost, previewToken });
    await log(`Écriture et vérification de la configuration Caddy pour ${hosts.join(", ")}`);
    await agent.writeCaddySite(server, dir, block);
    await log("Bascule du lien « current » vers la nouvelle release");
    await agent.switchRelease(server, dir, name);
    await log("Rechargement de Caddy (certificat HTTPS automatique)");
    await agent.reloadCaddy(server);
  },

  /** Production only: a switch of `current`, the Caddy block does not change. */
  async rollback(agent, { server, slug, releaseId, log }) {
    const name = releaseName(releaseId);
    const dir = siteDir(slug, "production");
    if (!(await agent.hasRelease(server, dir, name))) {
      await log(`Release ${name} absente du serveur ${server.name}, il faut la renvoyer`);
      return false;
    }
    await log(`Retour instantané à la release ${name}`);
    await agent.switchRelease(server, dir, name);
    return true;
  },

  async prune(agent, { server, slug, environment, keepReleaseIds, log }) {
    const dir = siteDir(slug, environment);
    const removed = await agent.pruneReleases(server, dir, keepReleaseIds.map(releaseName));
    if (removed.length > 0) await log(`${removed.length} ancienne(s) version(s) supprimée(s)`);
    return removed.length;
  },
};

export function runtimeFor(kind: "static" | "docker"): SiteRuntime {
  if (kind === "static") return staticRuntime;
  throw new Error("Le runtime docker n'est pas disponible en v1.");
}
