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

  async promote(input: { repo: string; tag: string; commitSha?: string }) {
    await sleep(900);
    const repo = repos.get(input.repo);
    if (!repo) throw new Error(`Dépôt introuvable : ${input.repo}`);
    const target = input.commitSha ?? repo.branches.staging;
    if (!target) throw new Error("Aucune version en préproduction à publier");
    repo.branches.production = target;
    repo.tags.push(input.tag);
    return { commitSha: target, tag: input.tag };
  }

  /** Test helper. */
  static _repo(fullName: string) {
    return repos.get(fullName);
  }
}
