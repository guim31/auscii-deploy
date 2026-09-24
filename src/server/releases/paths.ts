import path from "node:path";
import { env } from "../env";

/**
 * Runtime data folder. The magic comment keeps Turbopack's file tracing from
 * treating process.cwd() as a dependency, which would copy the whole project
 * (sources, docs, .env) into the standalone build.
 */
export function dataDir(): string {
  return path.resolve(/* turbopackIgnore: true */ process.cwd(), env().DATA_DIR);
}

export function releaseDir(releaseId: string): string {
  return path.join(/* turbopackIgnore: true */ dataDir(), "releases", releaseId);
}

export function uploadsDir(): string {
  return path.join(/* turbopackIgnore: true */ dataDir(), "uploads");
}

export function screenshotsDir(): string {
  return path.join(/* turbopackIgnore: true */ dataDir(), "screenshots");
}
