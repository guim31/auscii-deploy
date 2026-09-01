import path from "node:path";
import { env } from "../env";

export function dataDir(): string {
  return path.resolve(process.cwd(), env().DATA_DIR);
}

export function releaseDir(releaseId: string): string {
  return path.join(dataDir(), "releases", releaseId);
}

export function uploadsDir(): string {
  return path.join(dataDir(), "uploads");
}

export function screenshotsDir(): string {
  return path.join(dataDir(), "screenshots");
}
