import type { GitBranch, GitProvider } from "../types";
import { fakeSha, sleep } from "../mock-utils";

const repos = new Map<string, { branches: Record<GitBranch, string | null>; tags: string[] }>();
const tagShas = new Map<string, string>();

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
    // Like the real provider: same tag on the same commit is a no-op, a tag
    // taken by another commit gets the next free suffix.
    let tag = input.tag;
    for (let i = 2; tagShas.has(`${input.repo}@${tag}`); i++) {
      if (tagShas.get(`${input.repo}@${tag}`) === target) return { commitSha: target, tag };
      tag = `${input.tag}-${i}`;
    }
    tagShas.set(`${input.repo}@${tag}`, target);
    repo.tags.push(tag);
    return { commitSha: target, tag };
  }

  /** Test helper. */
  static _repo(fullName: string) {
    return repos.get(fullName);
  }
}
