import type { ServerAgent, ServerRef } from "../providers/types";
import { previewCaddyBlock, productionCaddyBlock } from "./caddy";

export type RuntimeDeployInput = {
  server: ServerRef;
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
  rollback(
    agent: ServerAgent,
    input: Pick<RuntimeDeployInput, "server" | "slug" | "releaseId" | "log">,
  ): Promise<void>;
}

export function releaseName(releaseId: string): string {
  return `rel-${releaseId}`;
}

function caddyName(slug: string, environment: "staging" | "production") {
  return environment === "production" ? slug : `${slug}--preview`;
}

export const staticRuntime: SiteRuntime = {
  kind: "static",

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
    const siteSlug = environment === "production" ? slug : `${slug}--preview`;
    await log(`Préparation des dossiers /srv/sites/${siteSlug} sur ${server.name}`);
    await agent.ensureSiteDirs(server, siteSlug);
    await log(`Envoi de la release ${name} (${releaseDir})`);
    await agent.uploadRelease(server, siteSlug, releaseDir, name);
    await log("Bascule du lien « current » vers la nouvelle release");
    await agent.switchRelease(server, siteSlug, name);
    const block =
      environment === "production"
        ? productionCaddyBlock({ slug: siteSlug, hosts, pilotHost })
        : previewCaddyBlock({ slug: siteSlug, hosts, pilotHost, previewToken });
    await log(`Écriture de la configuration Caddy pour ${hosts.join(", ")}`);
    await agent.writeCaddySite(server, caddyName(slug, environment), block);
    await log("Rechargement de Caddy (certificat HTTPS automatique)");
    await agent.reloadCaddy(server);
  },

  async rollback(agent, { server, slug, releaseId, log }) {
    const name = releaseName(releaseId);
    await log(`Retour à la release ${name}`);
    await agent.switchRelease(server, slug, name);
  },
};

export function runtimeFor(kind: "static" | "docker"): SiteRuntime {
  if (kind === "static") return staticRuntime;
  throw new Error("Le runtime docker n'est pas disponible en v1.");
}
