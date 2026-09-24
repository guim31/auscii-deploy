import { prisma } from "../db";
import { env } from "../env";
import { decryptJson } from "../crypto";
import { getSettings, isDemoMode } from "../settings";
import type { Providers } from "./types";
import { MockDomainProvider } from "./domain/mock";
import { GandiProvider, type GandiCredentials } from "./domain/gandi";
import { MockCloudProvider } from "./cloud/mock";
import { ScalewayProvider, type ScalewayCredentials } from "./cloud/scaleway";
import { MockGitProvider } from "./git/mock";
import { GitHubProvider, type GitHubCredentials } from "./git/github";
import { MockMailProvider } from "./mail/mock";
import { defaultSender, ResendProvider, type ResendCredentials } from "./mail/resend";
import { MockAiProvider } from "./ai/mock";
import { AnthropicProvider, type AnthropicCredentials } from "./ai/anthropic";
import { MockServerAgent } from "./agent/mock";
import { SshServerAgent, type SshCredentials } from "./agent/ssh";
import { MockScreenshotProvider } from "./screenshot/mock";
import { PlaywrightScreenshotProvider } from "./screenshot/playwright";

export * from "./types";

export const INTEGRATIONS = ["gandi", "scaleway", "github", "resend", "anthropic", "ssh"] as const;
export type IntegrationName = (typeof INTEGRATIONS)[number];

export type IntegrationCredentials = {
  gandi: GandiCredentials;
  scaleway: ScalewayCredentials;
  github: GitHubCredentials;
  resend: ResendCredentials;
  anthropic: AnthropicCredentials;
  ssh: SshCredentials;
};

export async function loadCredentials<N extends IntegrationName>(
  name: N,
): Promise<IntegrationCredentials[N] | null> {
  const row = await prisma.integration.findUnique({ where: { provider: name } });
  if (!row) return null;
  return decryptJson<IntegrationCredentials[N]>(row.encrypted, env().APP_ENCRYPTION_KEY);
}

const mocks: Providers = {
  demo: true,
  domain: new MockDomainProvider(),
  cloud: new MockCloudProvider(),
  git: new MockGitProvider(),
  mail: new MockMailProvider(),
  ai: new MockAiProvider(),
  agent: new MockServerAgent(),
  screenshot: new MockScreenshotProvider(),
};

export function getMockProviders(): Providers {
  return mocks;
}

/**
 * Returns the provider set. Pass `demo` from the entity being processed
 * (`site.isDemo`, `server.isDemo`): a job must never switch between mocks and
 * real integrations because someone toggled the demo mode meanwhile. Without
 * it, the current mode decides (forced by DEMO_MODE=true, or toggled in the UI).
 */
export async function getProviders(opts?: { demo?: boolean }): Promise<Providers> {
  const demo = opts?.demo ?? (await isDemoMode());
  if (demo) return mocks;
  const [settings, gandi, scaleway, github, resend, anthropic, ssh] = await Promise.all([
    getSettings(),
    loadCredentials("gandi"),
    loadCredentials("scaleway"),
    loadCredentials("github"),
    loadCredentials("resend"),
    loadCredentials("anthropic"),
    loadCredentials("ssh"),
  ]);
  return {
    demo: false,
    domain: new GandiProvider(gandi),
    cloud: new ScalewayProvider(scaleway),
    git: new GitHubProvider(github),
    // Same fallback as the settings test email: an empty sender field must not
    // make form messages and alerts fail.
    mail: new ResendProvider(resend, undefined, {
      defaultFrom: defaultSender(settings.agencyName, settings.techDomain),
    }),
    ai: new AnthropicProvider(anthropic),
    agent: new SshServerAgent(ssh),
    screenshot: new PlaywrightScreenshotProvider(),
  };
}
