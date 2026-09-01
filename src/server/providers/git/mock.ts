import type { GitBranch, GitProvider } from "../types";
import { fakeSha, sleep } from "../mock-utils";

const repos = new Map<string, { branches: Record<GitBranch, string | null>; tags: string[] }>();

export class MockGitProvider implements GitProvider {
  readonly name = "mock-github";
  constructor(private readonly org = "auscii") {}

  async createRepo(slug: string) {
    await sleep(1000);
    const fullName = `${this.org}/${slug}`;
    if (!repos.has(fullName))
      repos.set(fullName, { branches: { staging: null, production: null }, tags: [] });
    return { fullName, url: `https://github.com/${fullName}` };
  }

  async pushRelease(input: {
    repo: string;
    releaseDir: string;
    branch: GitBranch;
    message: string;
  }) {
    await sleep(1400);
    const repo = repos.get(input.repo);
    if (!repo) throw new Error(`Dépôt introuvable : ${input.repo}`);
    const commitSha = fakeSha(`${input.repo}:${input.branch}`);
    repo.branches[input.branch] = commitSha;
    return { commitSha };
  }

  async promote(input: { repo: string; tag: string }) {
    await sleep(900);
    const repo = repos.get(input.repo);
    if (!repo) throw new Error(`Dépôt introuvable : ${input.repo}`);
    if (!repo.branches.staging) throw new Error("Aucune version en préproduction à publier");
    repo.branches.production = repo.branches.staging;
    repo.tags.push(input.tag);
    return { commitSha: repo.branches.staging, tag: input.tag };
  }

  /** Test helper. */
  static _repo(fullName: string) {
    return repos.get(fullName);
  }
}
