import { prisma } from "../db";
import { env } from "../env";
import { decryptJson } from "../crypto";
import { isDemoMode } from "../settings";
import type { Providers } from "./types";
import { MockDomainProvider } from "./domain/mock";
import { GandiProvider, type GandiCredentials } from "./domain/gandi";
import { MockCloudProvider } from "./cloud/mock";
import { ScalewayProvider, type ScalewayCredentials } from "./cloud/scaleway";
import { MockGitProvider } from "./git/mock";
import { GitHubProvider, type GitHubCredentials } from "./git/github";
import { MockMailProvider } from "./mail/mock";
import { ResendProvider, type ResendCredentials } from "./mail/resend";
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
 * Returns the provider set for the current mode. Demo mode (forced by
 * DEMO_MODE=true, or toggled in the UI) always returns mocks, so the whole
 * pipeline works without network access.
 */
export async function getProviders(): Promise<Providers> {
  if (await isDemoMode()) return mocks;
  const [gandi, scaleway, github, resend, anthropic, ssh] = await Promise.all([
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
    mail: new ResendProvider(resend),
    ai: new AnthropicProvider(anthropic),
    agent: new SshServerAgent(ssh),
    screenshot: new PlaywrightScreenshotProvider(),
  };
}
